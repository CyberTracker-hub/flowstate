import type {
  DetectionResult,
  EventState,
  FactorType,
  Observation,
  PriorNotification,
  Severity,
  Transition,
} from "@flowstate/anomaly-engine";
import { snapshotToObservation, type NormalizedSnapshot, type TokenMetadata } from "@flowstate/market-data";
import type { AlertChannel, AlertRule, FailureKind, PlanId } from "@flowstate/shared";

/**
 * Persistence boundary of the worker. The pipeline only talks to this
 * interface, so the in-memory implementation below (demo mode, tests) and the
 * PostgreSQL implementation (live mode; not written yet) are interchangeable.
 *
 * Every write that can be repeated by a retried job reports whether it
 * actually inserted, which is what makes the pipeline idempotent.
 */

export type AnomalyType = FactorType | "composite";

export interface Delivery {
  /** Idempotency key; unique. */
  key: string;
  ruleId: string;
  userId: string;
  channel: AlertChannel;
  mint: string;
  eventId: string | null;
  observed: number | null;
  createdAt: number;
  status: "queued" | "sent" | "failed";
}

export interface ProviderStatusRecord {
  provider: string;
  checkedAt: number;
  status: "ok" | "degraded" | "down";
  latencyMs: number | null;
  errorKind: FailureKind | null;
}

export interface RuleWithOwnerPlan {
  rule: AlertRule;
  /** The owner's CURRENT effective plan, derived server-side from billing state. */
  plan: PlanId;
}

export interface Store {
  /** Insert a snapshot. Returns false when this (mint, provider, observedAt) already exists. */
  saveSnapshot(snapshot: NormalizedSnapshot): Promise<boolean>;
  upsertTokenMetadata(metadata: TokenMetadata): Promise<void>;
  /** Up to `limit` observations strictly before `beforeObservedAt`, oldest first. */
  getHistory(mint: string, beforeObservedAt: number, limit: number): Promise<Observation[]>;
  hasDetection(mint: string, observedAt: number, scoreVersion: string): Promise<boolean>;
  /** Marks a snapshot as fully processed. Returns false when it already was. */
  saveDetection(mint: string, observedAt: number, result: DetectionResult): Promise<boolean>;
  getOpenEvent(mint: string): Promise<EventState | null>;
  saveEvent(state: EventState, transition: Transition | null, evidence: DetectionResult | null): Promise<void>;
  getPriorNotification(mint: string, type: AnomalyType): Promise<PriorNotification | null>;
  recordNotification(mint: string, type: AnomalyType, at: number, severity: Severity): Promise<void>;
  listRulesForMint(mint: string): Promise<RuleWithOwnerPlan[]>;
  getRuleLastFiredAt(ruleId: string, mint: string): Promise<number | null>;
  /** Insert a delivery. Returns false when the idempotency key already exists. */
  saveDelivery(delivery: Delivery): Promise<boolean>;
  recordProviderStatus(status: ProviderStatusRecord): Promise<void>;
  setCheckpoint(provider: string, streamKey: string, lastSuccessAt: number): Promise<void>;
}

export class InMemoryStore implements Store {
  readonly snapshots = new Map<string, NormalizedSnapshot[]>();
  readonly tokens = new Map<string, TokenMetadata>();
  readonly detections = new Map<string, DetectionResult>();
  readonly events = new Map<string, EventState>();
  readonly transitions: Array<{ eventId: string; transition: Transition }> = [];
  readonly evidence = new Map<string, DetectionResult>();
  readonly notifications: Array<{ mint: string; type: AnomalyType; at: number; severity: Severity }> = [];
  readonly deliveries = new Map<string, Delivery>();
  readonly providerStatus: ProviderStatusRecord[] = [];
  readonly checkpoints = new Map<string, number>();
  readonly rules: RuleWithOwnerPlan[] = [];
  private readonly snapshotKeys = new Set<string>();
  private readonly openEventByMint = new Map<string, string>();
  private readonly lastFired = new Map<string, number>();

  async saveSnapshot(snapshot: NormalizedSnapshot): Promise<boolean> {
    const key = `${snapshot.mint}|${snapshot.provider}|${snapshot.observedAt}`;
    if (this.snapshotKeys.has(key)) return false;
    this.snapshotKeys.add(key);
    const list = this.snapshots.get(snapshot.mint) ?? [];
    list.push(snapshot);
    list.sort((a, b) => a.observedAt - b.observedAt);
    this.snapshots.set(snapshot.mint, list);
    return true;
  }

  async upsertTokenMetadata(metadata: TokenMetadata): Promise<void> {
    this.tokens.set(metadata.mint, metadata);
  }

  async getHistory(mint: string, beforeObservedAt: number, limit: number): Promise<Observation[]> {
    const list = this.snapshots.get(mint) ?? [];
    return list
      .filter((s) => s.observedAt < beforeObservedAt)
      .slice(-limit)
      .map(snapshotToObservation);
  }

  async hasDetection(mint: string, observedAt: number, scoreVersion: string): Promise<boolean> {
    return this.detections.has(`${mint}|${observedAt}|${scoreVersion}`);
  }

  async saveDetection(mint: string, observedAt: number, result: DetectionResult): Promise<boolean> {
    const key = `${mint}|${observedAt}|${result.scoreVersion}`;
    if (this.detections.has(key)) return false;
    this.detections.set(key, result);
    return true;
  }

  async getOpenEvent(mint: string): Promise<EventState | null> {
    const id = this.openEventByMint.get(mint);
    return id === undefined ? null : (this.events.get(id) ?? null);
  }

  async saveEvent(state: EventState, transition: Transition | null, evidence: DetectionResult | null): Promise<void> {
    this.events.set(state.eventId, state);
    if (state.status === "resolved" || state.status === "expired") {
      if (this.openEventByMint.get(state.mint) === state.eventId) this.openEventByMint.delete(state.mint);
    } else {
      this.openEventByMint.set(state.mint, state.eventId);
    }
    if (transition) this.transitions.push({ eventId: state.eventId, transition });
    // Keep the evidence of the strongest observation of each event.
    if (evidence && evidence.score !== null && evidence.score >= state.peakScore) {
      this.evidence.set(state.eventId, evidence);
    }
  }

  async getPriorNotification(mint: string, type: AnomalyType): Promise<PriorNotification | null> {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      const n = this.notifications[i];
      if (n && n.mint === mint && n.type === type) return { at: n.at, severity: n.severity };
    }
    return null;
  }

  async recordNotification(mint: string, type: AnomalyType, at: number, severity: Severity): Promise<void> {
    this.notifications.push({ mint, type, at, severity });
  }

  async listRulesForMint(mint: string): Promise<RuleWithOwnerPlan[]> {
    return this.rules.filter(({ rule }) =>
      rule.scope.kind === "token" ? rule.scope.mint === mint : rule.scope.mints.includes(mint),
    );
  }

  async getRuleLastFiredAt(ruleId: string, mint: string): Promise<number | null> {
    return this.lastFired.get(`${ruleId}|${mint}`) ?? null;
  }

  async saveDelivery(delivery: Delivery): Promise<boolean> {
    if (this.deliveries.has(delivery.key)) return false;
    this.deliveries.set(delivery.key, delivery);
    this.lastFired.set(`${delivery.ruleId}|${delivery.mint}`, delivery.createdAt);
    return true;
  }

  async recordProviderStatus(status: ProviderStatusRecord): Promise<void> {
    this.providerStatus.push(status);
  }

  async setCheckpoint(provider: string, streamKey: string, lastSuccessAt: number): Promise<void> {
    this.checkpoints.set(`${provider}|${streamKey}`, lastSuccessAt);
  }
}
