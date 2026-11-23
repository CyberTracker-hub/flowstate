export const FACTOR_TYPES = [
  "volume",
  "buyer_activity",
  "buy_sell_imbalance",
  "liquidity",
  "large_transaction",
  "price_volume_divergence",
] as const;

export type FactorType = (typeof FACTOR_TYPES)[number];

/**
 * One fixed-length aggregate bucket for a token (e.g. 5 minutes).
 *
 * `null` always means "not known" (missing, stale, unsupported or errored
 * upstream). It never means zero. A true zero is the number 0.
 */
export interface Observation {
  /** Epoch milliseconds. */
  periodStart: number;
  /** Epoch milliseconds. */
  periodEnd: number;
  priceUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  tradeCount: number | null;
  buyCount: number | null;
  sellCount: number | null;
  /** Only set when the provider genuinely deduplicates wallets. */
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  /** Largest single trade in the bucket; needs transaction-level coverage. */
  largestTradeUsd: number | null;
  /** Identifies who reported liquidity (provider + pool). Used to spot reporting changes. */
  liquiditySource: string | null;
}

export interface DetectionInput {
  mint: string;
  /** Evaluation time, epoch milliseconds. */
  now: number;
  current: Observation;
  /** Earlier buckets, oldest first, not including `current`. */
  history: readonly Observation[];
  tokenAgeMs: number | null;
  /**
   * Relative price disagreement between two independent providers
   * (|a - b| / mean), or null when only one provider is available.
   */
  providerPriceDisagreement: number | null;
}

export type UnavailableReason =
  | "missing_current"
  | "insufficient_history"
  | "insufficient_sample"
  | "unsupported_metric"
  | "baseline_too_small"
  | "reporting_change";

export type FactorDetail = Record<string, number | string | boolean | null>;

export interface AvailableFactor {
  type: FactorType;
  status: "available";
  maxPoints: number;
  /** intensity * maxPoints */
  points: number;
  /** 0..1 */
  intensity: number;
  observed: number;
  baseline: number | null;
  detail: FactorDetail;
}

export interface UnavailableFactor {
  type: FactorType;
  status: "unavailable";
  maxPoints: number;
  reason: UnavailableReason;
  detail: FactorDetail;
}

export type FactorResult = AvailableFactor | UnavailableFactor;

export type Severity = "normal" | "elevated" | "unusual" | "high" | "extreme";
export const SEVERITY_ORDER: readonly Severity[] = ["normal", "elevated", "unusual", "high", "extreme"];

export type Confidence = "insufficient" | "low" | "medium" | "high";
export const CONFIDENCE_ORDER: readonly Confidence[] = ["insufficient", "low", "medium", "high"];

export interface ConfidenceResult {
  category: Confidence;
  /** 0..1 internal index. NOT a calibrated probability. */
  index: number;
  components: {
    freshness: number;
    sampleSize: number;
    historicalCoverage: number;
    metricCoverage: number;
    /** null when only one provider is available. */
    providerConsistency: number | null;
  };
}

export interface DetectionResult {
  mint: string;
  evaluatedAt: number;
  scoreVersion: string;
  status: "scored" | "insufficient_data";
  /** 0..100 integer, or null when data coverage is below the scoring minimum. */
  score: number | null;
  severity: Severity | null;
  rawPoints: number;
  /** Sum of max points for the signals that could be computed. */
  availableMaxPoints: number;
  totalMaxPoints: number;
  /** availableMaxPoints / totalMaxPoints, 0..1 */
  coverage: number;
  /** Age of the current observation at evaluation time. */
  freshnessMs: number;
  /** Whether this result may create events or trigger notifications. */
  alertEligible: boolean;
  dominantFactor: FactorType | null;
  factors: FactorResult[];
  confidence: ConfidenceResult;
}

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export function confidenceRank(c: Confidence): number {
  return CONFIDENCE_ORDER.indexOf(c);
}
