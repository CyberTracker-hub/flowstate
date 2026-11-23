/**
 * Subscription plans and entitlements.
 *
 * This file is the single source of truth for prices and limits. Nothing
 * else in the codebase may hardcode them. Entitlements are always derived on
 * the server from verified billing state, never from anything the browser
 * sends.
 */

export const PLAN_IDS = ["free", "pro", "elite"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  priceUsdMonthly: number;
  liveFeed: boolean;
  /** Free users see events only after this delay. 0 for live plans. */
  feedDelaySeconds: number;
  advancedFilters: boolean;
  advancedIntelligenceFilters: boolean;
  telegramAlerts: boolean;
  prioritySupport: boolean;
  maxWatchlists: number;
  maxWatchedTokens: number;
  maxAlertRules: number;
  aiExplanationsPerMonth: number;
  /** How far back anomaly history is visible (also bounded by retained data). */
  historyDays: number;
  /** Expanded event details per day; null = unlimited. */
  eventDetailsPerDay: number | null;
}

/**
 * Initial product hypotheses. Values marked ASSUMPTION are not specified by
 * the product brief ("limited ...") and were chosen as conservative defaults.
 */
export const PLANS: Readonly<Record<PlanId, PlanLimits>> = {
  free: {
    priceUsdMonthly: 0,
    liveFeed: false,
    feedDelaySeconds: 15 * 60, // ASSUMPTION
    advancedFilters: false,
    advancedIntelligenceFilters: false,
    telegramAlerts: false,
    prioritySupport: false,
    maxWatchlists: 1,
    maxWatchedTokens: 10,
    maxAlertRules: 2, // ASSUMPTION (in-app only)
    aiExplanationsPerMonth: 5, // ASSUMPTION
    historyDays: 1, // ASSUMPTION
    eventDetailsPerDay: 10, // ASSUMPTION
  },
  pro: {
    priceUsdMonthly: 19,
    liveFeed: true,
    feedDelaySeconds: 0,
    advancedFilters: true,
    advancedIntelligenceFilters: false,
    telegramAlerts: true,
    prioritySupport: false,
    maxWatchlists: 5,
    maxWatchedTokens: 100,
    maxAlertRules: 20,
    aiExplanationsPerMonth: 100,
    historyDays: 30,
    eventDetailsPerDay: null,
  },
  elite: {
    priceUsdMonthly: 49,
    liveFeed: true,
    feedDelaySeconds: 0,
    advancedFilters: true,
    advancedIntelligenceFilters: true,
    telegramAlerts: true,
    prioritySupport: true,
    maxWatchlists: 20,
    maxWatchedTokens: 500,
    maxAlertRules: 100,
    aiExplanationsPerMonth: 500,
    historyDays: 180,
    eventDetailsPerDay: null,
  },
};

export function isPlanId(x: unknown): x is PlanId {
  return typeof x === "string" && (PLAN_IDS as readonly string[]).includes(x);
}

/** Stripe subscription statuses (https://docs.stripe.com/api/subscriptions/object). */
export type BillingStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface SubscriptionRecord {
  plan: string;
  status: string;
  /** Epoch milliseconds, or null when unknown. */
  currentPeriodEnd: number | null;
}

export interface EffectivePlan {
  plan: PlanId;
  reason:
    | "no_subscription"
    | "active"
    | "trialing"
    | "past_due_grace"
    | "past_due_expired"
    | "inactive_status"
    | "unknown_plan"
    | "unknown_status";
}

export interface EntitlementOptions {
  /** How long after period end a past_due subscription keeps its plan. */
  pastDueGraceMs: number;
}

export const DEFAULT_ENTITLEMENT_OPTIONS: EntitlementOptions = { pastDueGraceMs: 3 * 24 * 60 * 60 * 1000 };

/**
 * Map verified billing state to the plan whose limits apply right now.
 * Fails closed: anything unrecognised resolves to the free plan.
 */
export function effectivePlan(
  sub: SubscriptionRecord | null | undefined,
  now: number,
  opts: EntitlementOptions = DEFAULT_ENTITLEMENT_OPTIONS,
): EffectivePlan {
  if (!sub) return { plan: "free", reason: "no_subscription" };
  if (!isPlanId(sub.plan)) return { plan: "free", reason: "unknown_plan" };
  switch (sub.status as BillingStatus) {
    case "active":
      return { plan: sub.plan, reason: "active" };
    case "trialing":
      return { plan: sub.plan, reason: "trialing" };
    case "past_due": {
      const end = sub.currentPeriodEnd;
      if (typeof end === "number" && Number.isFinite(end) && now <= end + opts.pastDueGraceMs) {
        return { plan: sub.plan, reason: "past_due_grace" };
      }
      return { plan: "free", reason: "past_due_expired" };
    }
    case "incomplete":
    case "incomplete_expired":
    case "canceled":
    case "unpaid":
    case "paused":
      return { plan: "free", reason: "inactive_status" };
    default:
      return { plan: "free", reason: "unknown_status" };
  }
}

export type BooleanFeature =
  | "liveFeed"
  | "advancedFilters"
  | "advancedIntelligenceFilters"
  | "telegramAlerts"
  | "prioritySupport";

export function hasFeature(plan: PlanId, feature: BooleanFeature): boolean {
  return PLANS[plan][feature] === true;
}

export type CountedResource = "watchlists" | "watchedTokens" | "alertRules" | "aiExplanationsThisMonth";

const LIMIT_KEY: Record<CountedResource, keyof PlanLimits> = {
  watchlists: "maxWatchlists",
  watchedTokens: "maxWatchedTokens",
  alertRules: "maxAlertRules",
  aiExplanationsThisMonth: "aiExplanationsPerMonth",
};

export interface QuotaCheck {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
}

/** Would adding `adding` more of `resource` stay within the plan limit? */
export function checkQuota(plan: PlanId, resource: CountedResource, used: number, adding = 1): QuotaCheck {
  const limit = PLANS[plan][LIMIT_KEY[resource]] as number;
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  const safeAdding = Number.isFinite(adding) && adding > 0 ? Math.ceil(adding) : 0;
  return {
    allowed: safeUsed + safeAdding <= limit,
    limit,
    used: safeUsed,
    remaining: Math.max(0, limit - safeUsed),
  };
}

/** Oldest event timestamp this plan may read. */
export function historyCutoff(plan: PlanId, now: number): number {
  return now - PLANS[plan].historyDays * 24 * 60 * 60 * 1000;
}

/** Newest event timestamp this plan may read (free plans see a delayed feed). */
export function feedHorizon(plan: PlanId, now: number): number {
  return now - PLANS[plan].feedDelaySeconds * 1000;
}
