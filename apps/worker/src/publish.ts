import type { DetectionResult, EngineConfig, EventState, LifecycleConfig } from "@flowstate/anomaly-engine";
import {
  PUBLIC_SCHEMA,
  summarizeDetection,
  type PublicEvent,
  type PublicEvidence,
  type PublicHealth,
  type PublicOverview,
  type PublicSource,
  type PublicToken,
  type PublicTokenDetail,
} from "@flowstate/shared";
import type { JsonStateStore } from "./json-store";

/**
 * Turns the worker state into the JSON files the website reads. Pure: no
 * I/O, no clock other than the injected `now`. Nothing is filled in here;
 * unknown values stay null all the way to the page.
 */

export interface MonitoredToken {
  mint: string;
  symbol: string;
}

export interface PublishInput {
  store: JsonStateStore;
  tokens: readonly MonitoredToken[];
  now: number;
  engine: EngineConfig;
  lifecycle: LifecycleConfig;
  source: PublicSource;
  sparkLength?: number;
  seriesLength?: number;
  maxClosedEvents?: number;
}

export interface PublicData {
  overview: PublicOverview;
  details: Map<string, PublicTokenDetail>;
}

function stillOpen(e: EventState): boolean {
  return e.status !== "resolved" && e.status !== "expired";
}

function toEvidence(d: DetectionResult | undefined): PublicEvidence | null {
  if (d === undefined) return null;
  return {
    evaluatedAt: d.evaluatedAt,
    score: d.score,
    coverage: d.coverage,
    confidence: d.confidence.category,
    scoreVersion: d.scoreVersion,
    factors: d.factors,
  };
}

function healthOf(store: JsonStateStore, provider: string): PublicHealth {
  const last = store.cycles[store.cycles.length - 1];
  const lastSuccess = [...store.cycles].reverse().find((c) => c.ok > 0);
  if (last === undefined) {
    return { status: "down", lastCycleAt: null, lastSuccessAt: null, tokensRequested: 0, tokensOk: 0, tokensFailed: 0, failureKinds: {} };
  }
  // The checkpoint outlives the bounded cycle list.
  const checkpoint = store.checkpoints.get(`${provider}|token_overview`) ?? null;
  return {
    status: last.ok === 0 ? "down" : last.failed > 0 ? "degraded" : "ok",
    lastCycleAt: last.at,
    lastSuccessAt: lastSuccess?.at ?? checkpoint,
    tokensRequested: last.tokens,
    tokensOk: last.ok,
    tokensFailed: last.failed,
    failureKinds: last.failureKinds,
  };
}

export function buildPublicData(input: PublishInput): PublicData {
  const { store, now, engine, lifecycle } = input;
  const sparkLength = input.sparkLength ?? 48;
  const seriesLength = input.seriesLength ?? 288;
  const maxClosed = input.maxClosedEvents ?? 50;
  const symbolOf = new Map(input.tokens.map((t) => [t.mint, t.symbol]));

  const toEvent = (e: EventState): PublicEvent => {
    const evidence = store.evidence.get(e.eventId);
    return {
      id: e.eventId,
      mint: e.mint,
      symbol: symbolOf.get(e.mint) ?? store.tokens.get(e.mint)?.symbol ?? "?",
      type: e.anomalyType,
      status: e.status,
      score: e.score,
      severity: e.severity,
      peakScore: e.peakScore,
      peakSeverity: e.peakSeverity,
      detectedAt: e.detectedAt,
      updatedAt: e.updatedAt,
      resolvedAt: e.resolvedAt,
      updateCount: e.updateCount,
      evidence: toEvidence(evidence),
      summary: evidence ? summarizeDetection(evidence) : null,
    };
  };

  const allEvents = [...store.events.values()];
  const open = allEvents.filter(stillOpen).sort((a, b) => b.score - a.score || b.detectedAt - a.detectedAt);
  const closed = allEvents
    .filter((e) => !stillOpen(e))
    .sort((a, b) => (b.resolvedAt ?? b.updatedAt) - (a.resolvedAt ?? a.updatedAt));
  const openByMint = new Map(open.map((e) => [e.mint, e.eventId]));

  const tokens: PublicToken[] = [];
  const details = new Map<string, PublicTokenDetail>();
  for (const { mint, symbol } of input.tokens) {
    const rows = store.series.get(mint) ?? [];
    const last = rows[rows.length - 1];
    const meta = store.tokens.get(mint);
    const ctx = store.contexts.get(mint);
    const latest = store.latest.get(mint);
    // A detection only describes the reading it was computed for.
    const detection = latest !== undefined && last !== undefined && latest.observedAt === last.t ? latest.result : null;

    const token: PublicToken = {
      mint,
      symbol,
      name: meta?.name ?? null,
      logoUrl: meta?.logoUrl ?? null,
      observedAt: last?.t ?? null,
      priceUsd: last?.p ?? null,
      marketCapUsd: last?.m ?? null,
      liquidityUsd: last?.l ?? null,
      volume5mUsd: last?.v ?? null,
      buys5m: last?.b ?? null,
      sells5m: last?.s ?? null,
      change: ctx?.priceChangePct ?? { m5: null, h1: null, h6: null, h24: null },
      volumeH1Usd: ctx?.volumeH1Usd ?? null,
      volumeH24Usd: ctx?.volumeH24Usd ?? null,
      tradesH1: ctx?.tradesH1 ?? null,
      status: detection === null ? "no_data" : detection.status,
      score: detection?.score ?? null,
      severity: detection?.severity ?? null,
      coverage: detection?.coverage ?? null,
      confidence: detection?.confidence.category ?? null,
      alertEligible: detection?.alertEligible ?? false,
      dominantFactor: detection?.dominantFactor ?? null,
      samples: rows.length,
      spark: rows.slice(-sparkLength).map((r) => r.sc ?? null),
      openEventId: openByMint.get(mint) ?? null,
      poolCount: ctx?.pools.length ?? 0,
      pools: store.pins.get(mint)?.pools ?? [],
    };
    tokens.push(token);

    const recent = rows.slice(-seriesLength);
    details.set(mint, {
      schema: PUBLIC_SCHEMA,
      generatedAt: now,
      synthetic: store.synthetic,
      token,
      detection,
      series: {
        t: recent.map((r) => r.t),
        price: recent.map((r) => r.p),
        volume: recent.map((r) => r.v),
        liquidity: recent.map((r) => r.l),
        buys: recent.map((r) => r.b),
        sells: recent.map((r) => r.s),
        score: recent.map((r) => r.sc ?? null),
      },
      events: [...open, ...closed]
        .filter((e) => e.mint === mint)
        .slice(0, 20)
        .map((e) => ({ ...toEvent(e), transitions: store.transitions.get(e.eventId) ?? [] })),
      pools: ctx?.pools ?? [],
    });
  }

  const overview: PublicOverview = {
    schema: PUBLIC_SCHEMA,
    generatedAt: now,
    synthetic: store.synthetic,
    source: input.source,
    engine: {
      version: engine.version,
      weights: engine.weights,
      bands: engine.severityBands,
      eventThreshold: lifecycle.eventThreshold,
      minHistorySamples: engine.minHistorySamples,
      minCoverageForScore: engine.coverage.minForScore,
      minCoverageForAlert: engine.coverage.minForAlert,
      staleAfterMs: engine.freshness.staleAfterMs,
    },
    health: healthOf(store, store.provider),
    tokens,
    events: [...open, ...closed.slice(0, maxClosed)].map(toEvent),
  };
  return { overview, details };
}
