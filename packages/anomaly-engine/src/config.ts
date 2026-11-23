import { FACTOR_TYPES, type FactorType } from "./types";

/**
 * All tunable parameters of the scoring model.
 *
 * These are initial product parameters. They have NOT been validated as
 * predictive of anything. Any change must bump `version`, which is stored
 * with every event so historical scores stay interpretable.
 */
export interface EngineConfig {
  version: string;
  /** Maximum points per factor. Must sum to 100. */
  weights: Record<FactorType, number>;
  /** Length of one observation bucket. */
  bucketMs: number;
  /** Short baseline window, in buckets. */
  shortWindow: number;
  /** Long baseline window, in buckets. */
  longWindow: number;
  /** Minimum usable history points before a baseline is trusted. */
  minHistorySamples: number;
  volume: { ratioLo: number; ratioHi: number; zLo: number; zHi: number; minBaselineUsd: number };
  buyers: { ratioLo: number; ratioHi: number; zLo: number; zHi: number; minBaselineCount: number };
  imbalance: { minTrades: number; minBaselineTrades: number; deviationLo: number; deviationHi: number };
  liquidity: {
    baselineWindow: number;
    minSamples: number;
    minBaselineUsd: number;
    changeLo: number;
    changeHi: number;
  };
  largeTx: {
    shareLo: number;
    shareHi: number;
    historyRatioLo: number;
    historyRatioHi: number;
    minBaselineUsd: number;
  };
  divergence: { elevatedZ: number; quietZ: number; gapLo: number; gapHi: number };
  coverage: {
    /** Below this share of total weight, no score is produced at all. */
    minForScore: number;
    /** Below this share of total weight, the result can never alert. */
    minForAlert: number;
  };
  freshness: { staleAfterMs: number };
  confidence: {
    highThreshold: number;
    mediumThreshold: number;
    disagreementLo: number;
    disagreementHi: number;
  };
  /** Inclusive lower bounds of each band. */
  severityBands: { elevated: number; unusual: number; high: number; extreme: number };
}

const FIVE_MINUTES = 5 * 60 * 1000;

export const DEFAULT_CONFIG: EngineConfig = {
  version: "fs-score-1.0.0",
  weights: {
    volume: 25,
    buyer_activity: 20,
    buy_sell_imbalance: 15,
    liquidity: 15,
    large_transaction: 15,
    price_volume_divergence: 10,
  },
  bucketMs: FIVE_MINUTES,
  shortWindow: 12, // 1 hour of 5-minute buckets
  longWindow: 288, // 24 hours of 5-minute buckets
  minHistorySamples: 12,
  volume: { ratioLo: 1.5, ratioHi: 8, zLo: 2, zHi: 8, minBaselineUsd: 100 },
  buyers: { ratioLo: 1.5, ratioHi: 6, zLo: 2, zHi: 8, minBaselineCount: 3 },
  imbalance: { minTrades: 20, minBaselineTrades: 60, deviationLo: 0.2, deviationHi: 0.7 },
  liquidity: { baselineWindow: 6, minSamples: 3, minBaselineUsd: 1000, changeLo: 0.1, changeHi: 0.5 },
  largeTx: { shareLo: 0.005, shareHi: 0.05, historyRatioLo: 2, historyRatioHi: 10, minBaselineUsd: 1 },
  divergence: { elevatedZ: 3, quietZ: 1, gapLo: 2, gapHi: 8 },
  coverage: { minForScore: 0.4, minForAlert: 0.6 },
  freshness: { staleAfterMs: 3 * FIVE_MINUTES },
  confidence: { highThreshold: 0.75, mediumThreshold: 0.5, disagreementLo: 0.01, disagreementHi: 0.1 },
  severityBands: { elevated: 25, unusual: 50, high: 70, extreme: 85 },
};

/** Throws a descriptive error when a config is internally inconsistent. */
export function validateConfig(cfg: EngineConfig): void {
  const problems: string[] = [];
  let total = 0;
  for (const type of FACTOR_TYPES) {
    const w = cfg.weights[type];
    if (!Number.isFinite(w) || w < 0) problems.push(`weight for ${type} must be a non-negative number`);
    total += w;
  }
  if (Math.abs(total - 100) > 1e-9) problems.push(`weights must sum to 100 (got ${total})`);
  if (!cfg.version) problems.push("version is required");
  if (!(cfg.bucketMs > 0)) problems.push("bucketMs must be > 0");
  if (!(cfg.shortWindow > 0 && cfg.longWindow >= cfg.shortWindow)) {
    problems.push("windows must satisfy 0 < shortWindow <= longWindow");
  }
  if (!(cfg.minHistorySamples >= 3)) problems.push("minHistorySamples must be >= 3");
  const { minForScore, minForAlert } = cfg.coverage;
  if (!(minForScore > 0 && minForScore <= minForAlert && minForAlert <= 1)) {
    problems.push("coverage must satisfy 0 < minForScore <= minForAlert <= 1");
  }
  const b = cfg.severityBands;
  if (!(0 < b.elevated && b.elevated < b.unusual && b.unusual < b.high && b.high < b.extreme && b.extreme <= 100)) {
    problems.push("severity bands must be strictly increasing within (0, 100]");
  }
  if (problems.length > 0) throw new Error(`Invalid engine config: ${problems.join("; ")}`);
}
