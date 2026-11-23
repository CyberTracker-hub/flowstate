import type {
  Confidence,
  DetectionResult,
  EventStatus,
  FactorResult,
  FactorType,
  Severity,
  Transition,
} from "@flowstate/anomaly-engine";

/**
 * Shape of the JSON files the worker publishes and the website reads.
 * These files are the only interface between the two. `null` always means
 * "not known" and must be rendered as such, never as zero.
 */

export const PUBLIC_SCHEMA = 1;

export interface PublicChange {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export interface PublicToken {
  mint: string;
  /** Curated ticker from the monitored-token list. */
  symbol: string;
  /** Name as reported by the data source. Untrusted text: render as text only. */
  name: string | null;
  logoUrl: string | null;
  /** End of the latest 5-minute reading, or null when there is none yet. */
  observedAt: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  change: PublicChange;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  tradesH1: number | null;
  /** "no_data": nothing evaluated for the latest reading. */
  status: "scored" | "insufficient_data" | "no_data";
  score: number | null;
  severity: Severity | null;
  coverage: number | null;
  confidence: Confidence | null;
  alertEligible: boolean;
  dominantFactor: FactorType | null;
  /** Readings collected so far (the engine needs a baseline before it scores). */
  samples: number;
  /** Recent scores, oldest first. null = no score for that reading. */
  spark: Array<number | null>;
  openEventId: string | null;
  poolCount: number;
}

export interface PublicEvidence {
  evaluatedAt: number;
  score: number | null;
  coverage: number;
  confidence: Confidence;
  scoreVersion: string;
  factors: FactorResult[];
}

export interface PublicEvent {
  id: string;
  mint: string;
  symbol: string;
  type: FactorType | "composite";
  status: EventStatus;
  score: number;
  severity: Severity;
  peakScore: number;
  peakSeverity: Severity;
  detectedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  updateCount: number;
  /** Evidence of the strongest observation of the event. */
  evidence: PublicEvidence | null;
  /** Deterministic description built from the evidence. Not AI-generated. */
  summary: string | null;
}

export interface PublicHealth {
  status: "ok" | "degraded" | "down";
  lastCycleAt: number | null;
  lastSuccessAt: number | null;
  tokensRequested: number;
  tokensOk: number;
  tokensFailed: number;
  failureKinds: Record<string, number>;
}

export interface PublicSource {
  provider: string;
  name: string;
  url: string | null;
  intervalMs: number;
}

export interface PublicEngineInfo {
  version: string;
  weights: Record<FactorType, number>;
  bands: { elevated: number; unusual: number; high: number; extreme: number };
  eventThreshold: number;
  minHistorySamples: number;
  minCoverageForScore: number;
  minCoverageForAlert: number;
  staleAfterMs: number;
}

export interface PublicOverview {
  schema: typeof PUBLIC_SCHEMA;
  generatedAt: number;
  /** True only for demo fixtures. The website must label synthetic data. */
  synthetic: boolean;
  source: PublicSource;
  engine: PublicEngineInfo;
  health: PublicHealth;
  tokens: PublicToken[];
  /** Open events first (strongest first), then recently closed (newest first). */
  events: PublicEvent[];
}

export interface PublicSeries {
  t: number[];
  price: Array<number | null>;
  volume: Array<number | null>;
  liquidity: Array<number | null>;
  buys: Array<number | null>;
  sells: Array<number | null>;
  score: Array<number | null>;
}

export interface PublicPool {
  address: string;
  dexId: string | null;
  quoteSymbol: string | null;
  labels: string[];
  liquidityUsd: number | null;
  volumeH24Usd: number | null;
  url: string | null;
}

export interface PublicTokenDetail {
  schema: typeof PUBLIC_SCHEMA;
  generatedAt: number;
  synthetic: boolean;
  token: PublicToken;
  /** Full engine output for the latest reading. */
  detection: DetectionResult | null;
  series: PublicSeries;
  events: Array<PublicEvent & { transitions: Transition[] }>;
  pools: PublicPool[];
}
