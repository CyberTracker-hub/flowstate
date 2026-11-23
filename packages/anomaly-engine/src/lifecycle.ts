import { severityRank, type DetectionResult, type FactorType, type Severity } from "./types";

/**
 * Anomaly event lifecycle. One market movement must become ONE event that is
 * updated over time, not a stream of separate "discoveries".
 *
 *   (none) --qualifies--> detected --still qualifies--> active
 *   detected|active|updated --score/severity changed materially--> updated
 *   detected|active|updated --below threshold for resolveAfterMs--> resolved
 *   detected|active|updated --no usable data for expireAfterMs--> expired
 *
 * This module is pure: it decides, the caller persists.
 */

export type EventStatus = "detected" | "active" | "updated" | "resolved" | "expired";

export interface EventState {
  eventId: string;
  mint: string;
  /** Dominant factor when the event was created ("composite" if none stood out). */
  anomalyType: FactorType | "composite";
  status: EventStatus;
  score: number;
  severity: Severity;
  peakScore: number;
  peakSeverity: Severity;
  detectedAt: number;
  updatedAt: number;
  /** Last time a scored detection was applied to this event. */
  lastEvaluatedAt: number;
  resolvedAt: number | null;
  belowThresholdSince: number | null;
  lastNotifiedAt: number | null;
  lastNotifiedSeverity: Severity | null;
  updateCount: number;
}

export interface LifecycleConfig {
  /** Minimum score for a detection to open or sustain an event. */
  eventThreshold: number;
  /** How long the score must stay below threshold before the event resolves. */
  resolveAfterMs: number;
  /** How long without usable data before an open event expires. */
  expireAfterMs: number;
  /** Notification cooldown per token and anomaly type. */
  cooldownMs: number;
  /** Score change that counts as a material update. */
  updateScoreDelta: number;
}

const MINUTE = 60 * 1000;

export const DEFAULT_LIFECYCLE: LifecycleConfig = {
  eventThreshold: 50,
  resolveAfterMs: 15 * MINUTE,
  expireAfterMs: 60 * MINUTE,
  cooldownMs: 15 * MINUTE,
  updateScoreDelta: 5,
};

/** The most recent notification already sent for this token and anomaly type. */
export interface PriorNotification {
  at: number;
  severity: Severity;
}

export interface Transition {
  from: EventStatus | null;
  to: EventStatus;
  at: number;
  score: number | null;
  reason: string;
}

export interface LifecycleDecision {
  action: "create" | "update" | "hold" | "resolve" | "expire" | "none";
  state: EventState | null;
  transition: Transition | null;
  notify: boolean;
  notifyReason: "new_event" | "severity_increase" | "cooldown_elapsed" | null;
}

export function isOpen(state: EventState | null): state is EventState {
  return state !== null && state.status !== "resolved" && state.status !== "expired";
}

function qualifies(d: DetectionResult, cfg: LifecycleConfig): d is DetectionResult & { score: number; severity: Severity } {
  return d.status === "scored" && d.alertEligible && d.score !== null && d.severity !== null && d.score >= cfg.eventThreshold;
}

/**
 * Apply one detection result to the (possibly absent) open event for a token.
 *
 * @param existing  the token's currently open event, or null
 * @param detection the engine output for this evaluation
 * @param prior     last notification sent for this token + anomaly type by an
 *                  EARLIER event (used for the cooldown), or null
 * @param newId     id generator, called only when an event is created
 */
export function advance(
  existing: EventState | null,
  detection: DetectionResult,
  prior: PriorNotification | null,
  newId: () => string,
  cfg: LifecycleConfig = DEFAULT_LIFECYCLE,
): LifecycleDecision {
  const now = detection.evaluatedAt;
  const open = isOpen(existing) ? existing : null;

  if (open === null) {
    if (!qualifies(detection, cfg)) {
      return { action: "none", state: null, transition: null, notify: false, notifyReason: null };
    }
    const inCooldown = prior !== null && now - prior.at < cfg.cooldownMs;
    const escalated = prior !== null && severityRank(detection.severity) > severityRank(prior.severity);
    const notify = !inCooldown || escalated;
    const state: EventState = {
      eventId: newId(),
      mint: detection.mint,
      anomalyType: detection.dominantFactor ?? "composite",
      status: "detected",
      score: detection.score,
      severity: detection.severity,
      peakScore: detection.score,
      peakSeverity: detection.severity,
      detectedAt: now,
      updatedAt: now,
      lastEvaluatedAt: now,
      resolvedAt: null,
      belowThresholdSince: null,
      lastNotifiedAt: notify ? now : null,
      lastNotifiedSeverity: notify ? detection.severity : null,
      updateCount: 0,
    };
    return {
      action: "create",
      state,
      transition: { from: null, to: "detected", at: now, score: detection.score, reason: "score_above_threshold" },
      notify,
      notifyReason: notify ? (inCooldown ? "severity_increase" : "new_event") : null,
    };
  }

  // Unusable data: keep the event as it is. Expiry is handled by expireIfStale.
  if (detection.status !== "scored" || detection.score === null || detection.severity === null) {
    return { action: "hold", state: open, transition: null, notify: false, notifyReason: null };
  }

  if (qualifies(detection, cfg)) {
    const scoreMoved = Math.abs(detection.score - open.score) >= cfg.updateScoreDelta;
    const severityChanged = detection.severity !== open.severity;
    const material = scoreMoved || severityChanged;

    // Notify again only on a material severity increase over what the user
    // was last told, or once the cooldown has passed for an event whose
    // creation notification was suppressed.
    const reference = open.lastNotifiedSeverity ?? prior?.severity ?? null;
    let notify = false;
    let notifyReason: LifecycleDecision["notifyReason"] = null;
    if (reference === null || severityRank(detection.severity) > severityRank(reference)) {
      notify = true;
      notifyReason = reference === null ? "new_event" : "severity_increase";
    } else if (open.lastNotifiedAt === null && (prior === null || now - prior.at >= cfg.cooldownMs)) {
      notify = true;
      notifyReason = "cooldown_elapsed";
    }

    const nextStatus: EventStatus = material ? "updated" : open.status === "detected" ? "active" : open.status;
    const peakIsNew = detection.score > open.peakScore;
    const state: EventState = {
      ...open,
      status: nextStatus,
      score: material ? detection.score : open.score,
      severity: material ? detection.severity : open.severity,
      peakScore: peakIsNew ? detection.score : open.peakScore,
      peakSeverity: peakIsNew ? detection.severity : open.peakSeverity,
      updatedAt: material || nextStatus !== open.status ? now : open.updatedAt,
      lastEvaluatedAt: now,
      belowThresholdSince: null,
      lastNotifiedAt: notify ? now : open.lastNotifiedAt,
      lastNotifiedSeverity: notify ? detection.severity : open.lastNotifiedSeverity,
      updateCount: material ? open.updateCount + 1 : open.updateCount,
    };
    const changed = nextStatus !== open.status || material;
    return {
      action: changed ? "update" : "hold",
      state,
      transition: changed
        ? {
            from: open.status,
            to: nextStatus,
            at: now,
            score: detection.score,
            reason: material ? (severityChanged ? "severity_changed" : "score_changed") : "confirmed",
          }
        : null,
      notify,
      notifyReason,
    };
  }

  // Scored, but no longer qualifying.
  if (detection.score >= cfg.eventThreshold) {
    // Above threshold but not alert-eligible (e.g. coverage dropped): we cannot
    // call it resolved, and we cannot confirm it either.
    return { action: "hold", state: { ...open, lastEvaluatedAt: now }, transition: null, notify: false, notifyReason: null };
  }
  const belowSince = open.belowThresholdSince ?? now;
  if (now - belowSince >= cfg.resolveAfterMs) {
    const state: EventState = {
      ...open,
      status: "resolved",
      updatedAt: now,
      lastEvaluatedAt: now,
      resolvedAt: now,
      belowThresholdSince: belowSince,
    };
    return {
      action: "resolve",
      state,
      transition: { from: open.status, to: "resolved", at: now, score: detection.score, reason: "below_threshold" },
      notify: false,
      notifyReason: null,
    };
  }
  return {
    action: "hold",
    state: { ...open, lastEvaluatedAt: now, belowThresholdSince: belowSince },
    transition: null,
    notify: false,
    notifyReason: null,
  };
}

/** Expire an open event that has had no usable evaluation for too long. */
export function expireIfStale(
  existing: EventState | null,
  now: number,
  cfg: LifecycleConfig = DEFAULT_LIFECYCLE,
): LifecycleDecision {
  if (!isOpen(existing) || now - existing.lastEvaluatedAt < cfg.expireAfterMs) {
    return { action: "none", state: existing, transition: null, notify: false, notifyReason: null };
  }
  const state: EventState = { ...existing, status: "expired", updatedAt: now, resolvedAt: now };
  return {
    action: "expire",
    state,
    transition: { from: existing.status, to: "expired", at: now, score: null, reason: "no_usable_data" },
    notify: false,
    notifyReason: null,
  };
}
