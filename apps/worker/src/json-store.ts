import {
  DEFAULT_LIFECYCLE,
  expireIfStale,
  type Confidence,
  type DetectionResult,
  type EventState,
  type LifecycleConfig,
  type Observation,
  type PriorNotification,
  type Severity,
  type Transition,
} from "@flowstate/anomaly-engine";
import { metricValue, type MarketContext, type NormalizedSnapshot, type PoolPin, type TokenMetadata } from "@flowstate/market-data";
import type { AnomalyType, Delivery, ProviderStatusRecord, RuleWithOwnerPlan, Store } from "./store";

/**
 * File-backed store for the free, static deployment: the whole worker state
 * is one JSON document that is loaded at the start of a run and written back
 * at the end (GitHub Actions keeps it on a data branch). No database.
 *
 * The public website has no accounts, so there are no user alert rules and
 * no deliveries: those parts of the Store interface are deliberate no-ops.
 */

export const STATE_SCHEMA = 1;

/** One 5-minute reading of a token. `null` = not known, never zero. */
export interface SeriesRow {
  /** observedAt (end of the interval), epoch ms. */
  t: number;
  p: number | null;
  v: number | null;
  l: number | null;
  b: number | null;
  s: number | null;
  m: number | null;
  /** Identity of the liquidity source (pinned pool set). */
  k: string | null;
  /** Only present for providers that supply them. */
  ub?: number;
  us?: number;
  lt?: number;
  /** Detection outcome for this reading, once evaluated. */
  sc?: number | null;
  cv?: number;
  cf?: Confidence;
}

export interface CycleRecord {
  at: number;
  tokens: number;
  ok: number;
  failed: number;
  failureKinds: Record<string, number>;
  requests: number | null;
}

export interface PersistedState {
  schema: typeof STATE_SCHEMA;
  savedAt: number;
  provider: string;
  synthetic: boolean;
  intervalMs: number;
  tokens: Record<string, TokenMetadata>;
  series: Record<string, SeriesRow[]>;
  latest: Record<string, { observedAt: number; result: DetectionResult }>;
  events: EventState[];
  evidence: Record<string, DetectionResult>;
  transitions: Record<string, Transition[]>;
  notifications: Record<string, PriorNotification>;
  pins: Record<string, PoolPin>;
  contexts: Record<string, MarketContext>;
  checkpoints: Record<string, number>;
  cycles: CycleRecord[];
}

export interface JsonStoreOptions {
  provider: string;
  synthetic: boolean;
  intervalMs?: number;
  /** Readings kept per token (24 h of 5-minute buckets plus margin). */
  maxRows?: number;
  /** Readings older than this are dropped regardless of count. */
  maxRowAgeMs?: number;
  keepClosedEventsMs?: number;
  maxClosedEvents?: number;
  maxCycles?: number;
}

const DAY = 24 * 60 * 60_000;

/** Plain boolean (the engine's `isOpen` is a type guard and narrows the negative case away). */
function stillOpen(e: EventState): boolean {
  return e.status !== "resolved" && e.status !== "expired";
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Accept a previously saved state only when it is the same schema and the
 * same provider. Anything else starts from empty: mixing sources would
 * corrupt every baseline.
 */
export function readPersistedState(raw: unknown, expect: { provider: string }): PersistedState | null {
  if (!isRecord(raw) || raw.schema !== STATE_SCHEMA || raw.provider !== expect.provider) return null;
  for (const key of ["tokens", "series", "latest", "evidence", "transitions", "notifications", "pins", "contexts", "checkpoints"]) {
    if (!isRecord(raw[key])) return null;
  }
  if (!Array.isArray(raw.events) || !Array.isArray(raw.cycles)) return null;
  return raw as unknown as PersistedState;
}

export class JsonStateStore implements Store {
  readonly provider: string;
  readonly synthetic: boolean;
  readonly intervalMs: number;
  readonly tokens = new Map<string, TokenMetadata>();
  readonly series = new Map<string, SeriesRow[]>();
  readonly latest = new Map<string, { observedAt: number; result: DetectionResult }>();
  readonly events = new Map<string, EventState>();
  readonly evidence = new Map<string, DetectionResult>();
  readonly transitions = new Map<string, Transition[]>();
  readonly notifications = new Map<string, PriorNotification>();
  readonly pins = new Map<string, PoolPin>();
  readonly contexts = new Map<string, MarketContext>();
  readonly checkpoints = new Map<string, number>();
  readonly cycles: CycleRecord[] = [];
  readonly providerStatus: ProviderStatusRecord[] = [];
  private readonly openEventByMint = new Map<string, string>();
  private readonly opts: Required<JsonStoreOptions>;

  constructor(opts: JsonStoreOptions, state: PersistedState | null = null) {
    this.opts = {
      intervalMs: 5 * 60_000,
      maxRows: 300,
      maxRowAgeMs: 2 * DAY,
      keepClosedEventsMs: 7 * DAY,
      maxClosedEvents: 300,
      maxCycles: 60,
      ...opts,
    };
    this.provider = opts.provider;
    this.synthetic = opts.synthetic;
    this.intervalMs = this.opts.intervalMs;
    if (state === null) return;
    for (const [mint, meta] of Object.entries(state.tokens)) this.tokens.set(mint, meta);
    for (const [mint, rows] of Object.entries(state.series)) {
      this.series.set(mint, [...rows].sort((a, b) => a.t - b.t));
    }
    for (const [mint, entry] of Object.entries(state.latest)) this.latest.set(mint, entry);
    for (const event of state.events) {
      this.events.set(event.eventId, event);
      if (stillOpen(event)) this.openEventByMint.set(event.mint, event.eventId);
    }
    for (const [id, result] of Object.entries(state.evidence)) this.evidence.set(id, result);
    for (const [id, list] of Object.entries(state.transitions)) this.transitions.set(id, list);
    for (const [key, n] of Object.entries(state.notifications)) this.notifications.set(key, n);
    for (const [mint, pin] of Object.entries(state.pins)) this.pins.set(mint, pin);
    for (const [mint, ctx] of Object.entries(state.contexts)) this.contexts.set(mint, ctx);
    for (const [key, at] of Object.entries(state.checkpoints)) this.checkpoints.set(key, at);
    this.cycles.push(...state.cycles);
  }

  // ---- Store interface ----------------------------------------------------

  async saveSnapshot(snapshot: NormalizedSnapshot): Promise<boolean> {
    if (snapshot.provider !== this.provider) {
      throw new Error(`snapshot from "${snapshot.provider}" cannot be stored in a "${this.provider}" state`);
    }
    const rows = this.series.get(snapshot.mint) ?? [];
    if (rows.some((r) => r.t === snapshot.observedAt)) return false;
    const m = snapshot.metrics;
    const row: SeriesRow = {
      t: snapshot.observedAt,
      p: metricValue(m.priceUsd),
      v: metricValue(m.volumeUsd),
      l: metricValue(m.liquidityUsd),
      b: metricValue(m.buyCount),
      s: metricValue(m.sellCount),
      m: metricValue(m.marketCapUsd),
      k: snapshot.poolId,
    };
    const ub = metricValue(m.uniqueBuyers);
    const us = metricValue(m.uniqueSellers);
    const lt = metricValue(m.largestTradeUsd);
    if (ub !== null) row.ub = ub;
    if (us !== null) row.us = us;
    if (lt !== null) row.lt = lt;
    rows.push(row);
    rows.sort((a, b) => a.t - b.t);
    this.series.set(snapshot.mint, rows);
    return true;
  }

  async upsertTokenMetadata(metadata: TokenMetadata): Promise<void> {
    this.tokens.set(metadata.mint, metadata);
  }

  async getHistory(mint: string, beforeObservedAt: number, limit: number): Promise<Observation[]> {
    const rows = this.series.get(mint) ?? [];
    return rows
      .filter((r) => r.t < beforeObservedAt)
      .slice(-limit)
      .map((r) => this.toObservation(r));
  }

  async hasDetection(mint: string, observedAt: number, scoreVersion: string): Promise<boolean> {
    const entry = this.latest.get(mint);
    return entry !== undefined && entry.result.scoreVersion === scoreVersion && entry.observedAt >= observedAt;
  }

  async saveDetection(mint: string, observedAt: number, result: DetectionResult): Promise<boolean> {
    if (await this.hasDetection(mint, observedAt, result.scoreVersion)) return false;
    this.latest.set(mint, { observedAt, result });
    const row = (this.series.get(mint) ?? []).find((r) => r.t === observedAt);
    if (row) {
      row.sc = result.score;
      row.cv = Math.round(result.coverage * 1e4) / 1e4;
      row.cf = result.confidence.category;
    }
    return true;
  }

  async getOpenEvent(mint: string): Promise<EventState | null> {
    const id = this.openEventByMint.get(mint);
    return id === undefined ? null : (this.events.get(id) ?? null);
  }

  async saveEvent(state: EventState, transition: Transition | null, evidence: DetectionResult | null): Promise<void> {
    this.events.set(state.eventId, state);
    if (stillOpen(state)) this.openEventByMint.set(state.mint, state.eventId);
    else if (this.openEventByMint.get(state.mint) === state.eventId) this.openEventByMint.delete(state.mint);
    if (transition) {
      const list = this.transitions.get(state.eventId) ?? [];
      list.push(transition);
      this.transitions.set(state.eventId, list.slice(-40));
    }
    // Keep the evidence of the strongest observation of each event.
    if (evidence && evidence.score !== null && evidence.score >= state.peakScore) {
      this.evidence.set(state.eventId, evidence);
    }
  }

  async getPriorNotification(mint: string, type: AnomalyType): Promise<PriorNotification | null> {
    return this.notifications.get(`${mint}|${type}`) ?? null;
  }

  async recordNotification(mint: string, type: AnomalyType, at: number, severity: Severity): Promise<void> {
    this.notifications.set(`${mint}|${type}`, { at, severity });
  }

  /** No accounts on the public website, therefore no user alert rules. */
  async listRulesForMint(): Promise<RuleWithOwnerPlan[]> {
    return [];
  }

  async getRuleLastFiredAt(): Promise<number | null> {
    return null;
  }

  async saveDelivery(_delivery: Delivery): Promise<boolean> {
    return false;
  }

  async recordProviderStatus(status: ProviderStatusRecord): Promise<void> {
    // Per-run only; the durable summary is the cycle record.
    this.providerStatus.push(status);
  }

  async setCheckpoint(provider: string, streamKey: string, lastSuccessAt: number): Promise<void> {
    this.checkpoints.set(`${provider}|${streamKey}`, lastSuccessAt);
  }

  // ---- Extras for the static deployment ---------------------------------------

  toObservation(r: SeriesRow): Observation {
    return {
      periodStart: r.t - this.intervalMs,
      periodEnd: r.t,
      priceUsd: r.p,
      volumeUsd: r.v,
      liquidityUsd: r.l,
      tradeCount: r.b !== null && r.s !== null ? r.b + r.s : null,
      buyCount: r.b,
      sellCount: r.s,
      uniqueBuyers: r.ub ?? null,
      uniqueSellers: r.us ?? null,
      largestTradeUsd: r.lt ?? null,
      liquiditySource: `${this.provider}:${r.k ?? "aggregate"}`,
    };
  }

  recordCycle(record: CycleRecord): void {
    this.cycles.push(record);
    if (this.cycles.length > this.opts.maxCycles) this.cycles.splice(0, this.cycles.length - this.opts.maxCycles);
  }

  /**
   * Bound the state: trim old readings, expire open events that can no
   * longer be evaluated (e.g. the token left the monitored list) and drop
   * closed events past their retention.
   */
  prune(now: number, lifecycle: LifecycleConfig = DEFAULT_LIFECYCLE): { expired: number } {
    for (const [mint, rows] of this.series) {
      const kept = rows.filter((r) => now - r.t <= this.opts.maxRowAgeMs).slice(-this.opts.maxRows);
      if (kept.length === 0) this.series.delete(mint);
      else this.series.set(mint, kept);
    }

    let expired = 0;
    for (const event of [...this.events.values()]) {
      const decision = expireIfStale(event, now, lifecycle);
      if (decision.action === "expire" && decision.state) {
        this.events.set(event.eventId, decision.state);
        if (this.openEventByMint.get(event.mint) === event.eventId) this.openEventByMint.delete(event.mint);
        if (decision.transition) {
          this.transitions.set(event.eventId, [...(this.transitions.get(event.eventId) ?? []), decision.transition]);
        }
        expired += 1;
      }
    }

    const closed = [...this.events.values()]
      .filter((e) => !stillOpen(e))
      .sort((a, b) => (b.resolvedAt ?? b.updatedAt) - (a.resolvedAt ?? a.updatedAt));
    closed.forEach((event, index) => {
      const closedAt = event.resolvedAt ?? event.updatedAt;
      if (index >= this.opts.maxClosedEvents || now - closedAt > this.opts.keepClosedEventsMs) {
        this.events.delete(event.eventId);
        this.evidence.delete(event.eventId);
        this.transitions.delete(event.eventId);
      }
    });
    return { expired };
  }

  toJSON(now: number): PersistedState {
    const obj = <T>(map: Map<string, T>): Record<string, T> => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));
    return {
      schema: STATE_SCHEMA,
      savedAt: now,
      provider: this.provider,
      synthetic: this.synthetic,
      intervalMs: this.intervalMs,
      tokens: obj(this.tokens),
      series: obj(this.series),
      latest: obj(this.latest),
      events: [...this.events.values()].sort((a, b) => a.detectedAt - b.detectedAt),
      evidence: obj(this.evidence),
      transitions: obj(this.transitions),
      notifications: obj(this.notifications),
      pins: obj(this.pins),
      contexts: obj(this.contexts),
      checkpoints: obj(this.checkpoints),
      cycles: this.cycles,
    };
  }
}
