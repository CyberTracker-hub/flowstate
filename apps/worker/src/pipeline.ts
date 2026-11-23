import {
  DEFAULT_CONFIG,
  DEFAULT_LIFECYCLE,
  advance,
  detect,
  expireIfStale,
  type EngineConfig,
  type LifecycleConfig,
} from "@flowstate/anomaly-engine";
import { snapshotToObservation, type MarketDataProvider, type ProviderFetchResult } from "@flowstate/market-data";
import {
  ProviderError,
  contextFromDetection,
  deliveryKey,
  evaluateRule,
  withRetry,
  type CircuitBreaker,
  type FailureKind,
  type RetryOptions,
} from "@flowstate/shared";
import { silentLogger, type Logger } from "./logger";
import type { AnomalyType, Store } from "./store";

/**
 * One ingestion + detection cycle:
 *
 *   provider -> validate/normalize -> snapshot -> rolling history ->
 *   anomaly engine -> event lifecycle -> alert rules -> queued deliveries
 *
 * Properties this function guarantees (and tests assert):
 *   - A failing token or a failing provider never aborts the cycle.
 *   - Re-running a cycle for the same data creates nothing twice.
 *   - No value is invented: a failed fetch produces no snapshot at all.
 */

export interface PipelineDeps {
  provider: MarketDataProvider;
  store: Store;
  now: () => number;
  newId: () => string;
  engine?: EngineConfig;
  lifecycle?: LifecycleConfig;
  breaker?: CircuitBreaker;
  retry?: RetryOptions;
  logger?: Logger;
}

export interface CycleSummary {
  provider: string;
  synthetic: boolean;
  startedAt: number;
  tokens: number;
  snapshotsSaved: number;
  alreadyProcessed: number;
  detections: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsResolved: number;
  eventsExpired: number;
  notifications: number;
  deliveriesQueued: number;
  failures: Array<{ mint: string; kind: FailureKind | "unexpected" }>;
}

/** Failure kinds that say something about the provider as a whole. */
const PROVIDER_WIDE: ReadonlySet<FailureKind> = new Set(["rate_limited", "timeout", "network", "server", "auth"]);

export async function runCycle(mints: readonly string[], deps: PipelineDeps): Promise<CycleSummary> {
  const { provider, store, now } = deps;
  const engine = deps.engine ?? DEFAULT_CONFIG;
  const lifecycle = deps.lifecycle ?? DEFAULT_LIFECYCLE;
  const log = deps.logger ?? silentLogger;
  const retry: RetryOptions = deps.retry ?? { maxAttempts: 3 };

  const summary: CycleSummary = {
    provider: provider.name,
    synthetic: provider.synthetic,
    startedAt: now(),
    tokens: mints.length,
    snapshotsSaved: 0,
    alreadyProcessed: 0,
    detections: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsResolved: 0,
    eventsExpired: 0,
    notifications: 0,
    deliveriesQueued: 0,
    failures: [],
  };

  const expireOpenEvent = async (mint: string) => {
    const decision = expireIfStale(await store.getOpenEvent(mint), now(), lifecycle);
    if (decision.action === "expire" && decision.state) {
      await store.saveEvent(decision.state, decision.transition, null);
      summary.eventsExpired += 1;
    }
  };

  for (const mint of [...new Set(mints)]) {
    try {
      // ---- 1. Fetch -------------------------------------------------------
      if (deps.breaker && !deps.breaker.tryAcquire()) {
        summary.failures.push({ mint, kind: "circuit_open" });
        await expireOpenEvent(mint);
        continue;
      }
      const fetchStarted = now();
      let fetched: ProviderFetchResult;
      try {
        fetched = await withRetry(() => provider.fetchSnapshot(mint), retry);
      } catch (error) {
        const kind: FailureKind | "unexpected" = error instanceof ProviderError ? error.kind : "unexpected";
        const providerWide = kind !== "unexpected" && PROVIDER_WIDE.has(kind);
        // A bad record for one token says nothing about provider health.
        if (providerWide) deps.breaker?.recordFailure();
        else deps.breaker?.recordSuccess();
        summary.failures.push({ mint, kind });
        await store.recordProviderStatus({
          provider: provider.name,
          checkedAt: now(),
          status: providerWide ? "down" : "degraded",
          latencyMs: null,
          errorKind: kind === "unexpected" ? null : kind,
        });
        log.warn("snapshot fetch failed", { mint, provider: provider.name, kind, error });
        await expireOpenEvent(mint);
        continue;
      }
      deps.breaker?.recordSuccess();
      const { snapshot, metadata, issues } = fetched;
      await store.recordProviderStatus({
        provider: provider.name,
        checkedAt: now(),
        status: issues.length > 0 ? "degraded" : "ok",
        latencyMs: Math.max(0, now() - fetchStarted),
        errorKind: null,
      });
      if (issues.length > 0) log.warn("snapshot has data-quality issues", { mint, issues });

      // ---- 2. Persist (idempotent) ---------------------------------------
      if (metadata) await store.upsertTokenMetadata(metadata);
      if (await store.saveSnapshot(snapshot)) summary.snapshotsSaved += 1;
      if (await store.hasDetection(mint, snapshot.observedAt, engine.version)) {
        summary.alreadyProcessed += 1;
        continue;
      }

      // ---- 3. Detect ------------------------------------------------------
      const history = await store.getHistory(mint, snapshot.observedAt, engine.longWindow + 1);
      const detection = detect(
        {
          mint,
          now: now(),
          current: snapshotToObservation(snapshot),
          history,
          tokenAgeMs: null,
          providerPriceDisagreement: null,
        },
        engine,
      );
      summary.detections += 1;

      // ---- 4. Event lifecycle --------------------------------------------
      const existing = await store.getOpenEvent(mint);
      const type: AnomalyType = existing?.anomalyType ?? detection.dominantFactor ?? "composite";
      const prior = await store.getPriorNotification(mint, type);
      const decision = advance(existing, detection, prior, deps.newId, lifecycle);
      if (decision.state && decision.action !== "none") {
        await store.saveEvent(decision.state, decision.transition, detection);
        if (decision.action === "create") summary.eventsCreated += 1;
        else if (decision.action === "update") summary.eventsUpdated += 1;
        else if (decision.action === "resolve") summary.eventsResolved += 1;
      }
      if (decision.notify && decision.state) {
        await store.recordNotification(mint, decision.state.anomalyType, detection.evaluatedAt, decision.state.severity);
        summary.notifications += 1;
      }

      // ---- 5. User alert rules -------------------------------------------
      const openEventId = decision.state && decision.action !== "resolve" ? decision.state.eventId : null;
      const context = contextFromDetection(detection, openEventId);
      for (const { rule, plan } of await store.listRulesForMint(mint)) {
        const lastFiredAt = await store.getRuleLastFiredAt(rule.id, mint);
        const evaluation = evaluateRule(rule, context, lastFiredAt, plan);
        if (!evaluation.fire) continue;
        const inserted = await store.saveDelivery({
          // Keyed on the snapshot time, not wall-clock time, so a retried job
          // cannot queue the same alert twice.
          key: deliveryKey(rule, { mint, now: snapshot.observedAt }),
          ruleId: rule.id,
          userId: rule.userId,
          channel: rule.channel,
          mint,
          eventId: openEventId,
          observed: evaluation.observed,
          createdAt: context.now,
          status: "queued",
        });
        if (inserted) summary.deliveriesQueued += 1;
      }

      // ---- 6. Mark processed (last, so a crash before this point is retried)
      await store.saveDetection(mint, snapshot.observedAt, detection);
    } catch (error) {
      // Defensive: an unexpected bug for one token must not stop the others.
      summary.failures.push({ mint, kind: "unexpected" });
      log.error("unexpected error while processing token", { mint, error });
    }
  }

  if (summary.failures.length < summary.tokens || summary.tokens === 0) {
    await store.setCheckpoint(provider.name, "token_overview", now());
  }
  log.info("cycle complete", { ...summary, failures: summary.failures.length });
  return summary;
}
