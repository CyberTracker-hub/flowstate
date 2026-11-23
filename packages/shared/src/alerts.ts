import {
  confidenceRank,
  type Confidence,
  type DetectionResult,
  type Severity,
  severityRank,
} from "@flowstate/anomaly-engine";
import { hasFeature, type PlanId } from "./plans";

/**
 * Custom alert rules: pure evaluation logic. The worker supplies the context
 * and persistence; this module decides whether a rule fires and produces the
 * idempotency key for its delivery.
 */

export const ALERT_RULE_TYPES = [
  "anomaly_score",
  "volume_ratio",
  "liquidity_change",
  "price_change",
  "watchlist_high_severity",
] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

export const ALERT_OPERATORS = ["gt", "gte", "lt", "lte", "abs_gte"] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

export const ALERT_CHANNELS = ["in_app", "telegram"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export type AlertScope = { kind: "token"; mint: string } | { kind: "watchlist"; mints: readonly string[] };

export interface AlertRule {
  id: string;
  userId: string;
  scope: AlertScope;
  type: AlertRuleType;
  operator: AlertOperator;
  threshold: number;
  minConfidence: Confidence;
  cooldownSeconds: number;
  channel: AlertChannel;
  enabled: boolean;
}

/** Everything a rule may look at for one token at one evaluation. */
export interface AlertContext {
  mint: string;
  now: number;
  eventId: string | null;
  score: number | null;
  severity: Severity | null;
  confidence: Confidence;
  /** False when data coverage/freshness is too poor for any alert. */
  alertEligible: boolean;
  volumeRatio: number | null;
  /** Percent units, signed. */
  liquidityChangePct: number | null;
  /** Percent units, signed. */
  priceChangePct: number | null;
}

export type AlertOutcome =
  | "fired"
  | "disabled"
  | "out_of_scope"
  | "not_eligible"
  | "metric_unavailable"
  | "below_confidence"
  | "condition_not_met"
  | "cooldown"
  | "channel_not_allowed";

export interface AlertEvaluation {
  fire: boolean;
  outcome: AlertOutcome;
  observed: number | null;
}

function numberFromDetail(result: DetectionResult, factorType: string, key: string): number | null {
  const f = result.factors.find((x) => x.type === factorType);
  if (!f || f.status !== "available") return null;
  const v = f.detail[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Build the alert context from an engine result. Unavailable metrics stay null. */
export function contextFromDetection(result: DetectionResult, eventId: string | null): AlertContext {
  return {
    mint: result.mint,
    now: result.evaluatedAt,
    eventId,
    score: result.score,
    severity: result.severity,
    confidence: result.confidence.category,
    alertEligible: result.alertEligible,
    volumeRatio: numberFromDetail(result, "volume", "ratio"),
    liquidityChangePct: numberFromDetail(result, "liquidity", "changePct"),
    priceChangePct: numberFromDetail(result, "price_volume_divergence", "priceChangePct"),
  };
}

function inScope(scope: AlertScope, mint: string): boolean {
  return scope.kind === "token" ? scope.mint === mint : scope.mints.includes(mint);
}

function compare(observed: number, operator: AlertOperator, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return observed > threshold;
    case "gte":
      return observed >= threshold;
    case "lt":
      return observed < threshold;
    case "lte":
      return observed <= threshold;
    case "abs_gte":
      return Math.abs(observed) >= Math.abs(threshold);
  }
}

function observedValue(rule: AlertRule, ctx: AlertContext): number | null {
  switch (rule.type) {
    case "anomaly_score":
      return ctx.score;
    case "volume_ratio":
      return ctx.volumeRatio;
    case "liquidity_change":
      return ctx.liquidityChangePct;
    case "price_change":
      return ctx.priceChangePct;
    case "watchlist_high_severity":
      return ctx.severity === null ? null : severityRank(ctx.severity);
  }
}

/**
 * Decide whether `rule` fires for `ctx`.
 *
 * @param lastFiredAt when this rule last fired for this token, or null
 * @param plan        the owner's CURRENT effective plan (server-derived)
 */
export function evaluateRule(
  rule: AlertRule,
  ctx: AlertContext,
  lastFiredAt: number | null,
  plan: PlanId,
): AlertEvaluation {
  const no = (outcome: AlertOutcome, observed: number | null = null): AlertEvaluation => ({
    fire: false,
    outcome,
    observed,
  });
  if (!rule.enabled) return no("disabled");
  if (!inScope(rule.scope, ctx.mint)) return no("out_of_scope");
  // Entitlements are re-checked at fire time: a downgraded user's Telegram
  // rules must stop delivering even though the rule row still exists.
  if (rule.channel === "telegram" && !hasFeature(plan, "telegramAlerts")) return no("channel_not_allowed");
  if (!ctx.alertEligible) return no("not_eligible");

  const observed = observedValue(rule, ctx);
  if (observed === null || !Number.isFinite(observed)) return no("metric_unavailable");
  if (confidenceRank(ctx.confidence) < confidenceRank(rule.minConfidence)) return no("below_confidence", observed);

  const met =
    rule.type === "watchlist_high_severity"
      ? observed >= severityRank("high")
      : Number.isFinite(rule.threshold) && compare(observed, rule.operator, rule.threshold);
  if (!met) return no("condition_not_met", observed);

  const cooldownMs = Math.max(0, rule.cooldownSeconds) * 1000;
  if (lastFiredAt !== null && ctx.now - lastFiredAt < cooldownMs) return no("cooldown", observed);

  return { fire: true, outcome: "fired", observed };
}

/**
 * Idempotency key for one firing of one rule. The evaluation timestamp comes
 * from the detection run, so re-processing the same job yields the same key
 * and a unique constraint on it prevents duplicate deliveries.
 */
export function deliveryKey(rule: Pick<AlertRule, "id" | "channel">, ctx: Pick<AlertContext, "mint" | "now">): string {
  return `${rule.id}:${rule.channel}:${ctx.mint}:${ctx.now}`;
}

export interface RuleValidationIssue {
  field: string;
  message: string;
}

/** Server-side validation of a rule before it is stored. */
export function validateRule(rule: AlertRule): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  if (!(ALERT_RULE_TYPES as readonly string[]).includes(rule.type)) issues.push({ field: "type", message: "unknown rule type" });
  if (!(ALERT_OPERATORS as readonly string[]).includes(rule.operator)) issues.push({ field: "operator", message: "unknown operator" });
  if (!(ALERT_CHANNELS as readonly string[]).includes(rule.channel)) issues.push({ field: "channel", message: "unknown channel" });
  if (rule.type !== "watchlist_high_severity" && !Number.isFinite(rule.threshold)) {
    issues.push({ field: "threshold", message: "threshold must be a finite number" });
  }
  if (rule.type === "anomaly_score" && (rule.threshold < 0 || rule.threshold > 100)) {
    issues.push({ field: "threshold", message: "score threshold must be between 0 and 100" });
  }
  if (rule.type === "volume_ratio" && rule.threshold <= 0) {
    issues.push({ field: "threshold", message: "volume ratio threshold must be positive" });
  }
  if (!Number.isFinite(rule.cooldownSeconds) || rule.cooldownSeconds < 60 || rule.cooldownSeconds > 86_400) {
    issues.push({ field: "cooldownSeconds", message: "cooldown must be between 60 seconds and 24 hours" });
  }
  if (rule.type === "watchlist_high_severity" && rule.scope.kind !== "watchlist") {
    issues.push({ field: "scope", message: "this rule type requires a watchlist scope" });
  }
  if (rule.scope.kind === "token" && rule.scope.mint.length === 0) {
    issues.push({ field: "scope", message: "token mint is required" });
  }
  return issues;
}
