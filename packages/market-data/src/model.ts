import type { Observation } from "@flowstate/anomaly-engine";

/**
 * Normalized market-data model shared by every provider adapter.
 *
 * A metric is never silently defaulted. Each one carries an explicit state:
 *   ok          - a validated value (which may be a true zero)
 *   stale       - a value that is too old to describe the current interval
 *   missing     - the provider supports it but did not return it this time
 *   unsupported - this provider/plan cannot supply the metric at all
 *   error       - the provider returned something invalid for it
 */
export type Metric =
  | { state: "ok"; value: number }
  | { state: "stale"; value: number; observedAt: number }
  | { state: "missing" }
  | { state: "unsupported" }
  | { state: "error"; code: string };

export const METRIC_KEYS = [
  "priceUsd",
  "marketCapUsd",
  "liquidityUsd",
  "volumeUsd",
  "tradeCount",
  "buyCount",
  "sellCount",
  "uniqueBuyers",
  "uniqueSellers",
  "holderCount",
  "largestTradeUsd",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface Completeness {
  /** Metrics this provider can supply. */
  supported: number;
  /** Supported metrics that arrived valid. */
  ok: number;
  /** ok / supported, 0..1 */
  ratio: number;
}

export interface NormalizedSnapshot {
  chain: "solana";
  mint: string;
  provider: string;
  /** True only for demo fixtures. Synthetic data must never be shown as live. */
  synthetic: boolean;
  /** End of the interval the windowed metrics describe (bucket-aligned), epoch ms. */
  observedAt: number;
  /** Length of the interval for volume and count metrics. */
  intervalMs: number;
  /** Provider's own timestamp for the data (e.g. last trade), when given. */
  providerTimestamp: number | null;
  ingestedAt: number;
  poolId: string | null;
  metrics: Record<MetricKey, Metric>;
  completeness: Completeness;
}

export interface TokenMetadata {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  logoUrl: string | null;
}

export const MISSING: Metric = { state: "missing" };
export const UNSUPPORTED: Metric = { state: "unsupported" };

export function okMetric(value: number): Metric {
  return { state: "ok", value };
}

/** The usable value of a metric: only "ok" counts. Everything else is unknown. */
export function metricValue(m: Metric): number | null {
  return m.state === "ok" ? m.value : null;
}

export interface ReadOptions {
  integer?: boolean;
  /** Inclusive lower bound. Default 0. */
  min?: number;
  /** Exclusive lower bound (e.g. price must be > 0). */
  greaterThan?: number;
  /** Inclusive upper bound; guards against absurd values. */
  max?: number;
}

/**
 * Validate one raw provider value. Absent => missing. Present but not a sane
 * number => error (never coerced, never defaulted).
 */
export function readMetric(raw: unknown, opts: ReadOptions = {}): Metric {
  if (raw === undefined || raw === null) return MISSING;
  if (typeof raw !== "number") return { state: "error", code: "not_a_number" };
  if (!Number.isFinite(raw)) return { state: "error", code: "not_finite" };
  const min = opts.min ?? 0;
  if (raw < min) return { state: "error", code: "below_minimum" };
  if (opts.greaterThan !== undefined && !(raw > opts.greaterThan)) return { state: "error", code: "below_minimum" };
  if (opts.max !== undefined && raw > opts.max) return { state: "error", code: "above_maximum" };
  if (opts.integer && !Number.isInteger(raw)) return { state: "error", code: "not_integer" };
  return okMetric(raw);
}

export function computeCompleteness(metrics: Record<MetricKey, Metric>): Completeness {
  let supported = 0;
  let ok = 0;
  for (const key of METRIC_KEYS) {
    const m = metrics[key];
    if (m.state === "unsupported") continue;
    supported += 1;
    if (m.state === "ok") ok += 1;
  }
  return { supported, ok, ratio: supported > 0 ? Math.round((ok / supported) * 1e4) / 1e4 : 0 };
}

// C0/C1 control characters, zero-width characters and bidirectional overrides.
// The latter two are classic tools for spoofing token names.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Clean untrusted token text (name, symbol). The result is still UNTRUSTED
 * plain text: it must be rendered as text, never as HTML, and never passed to
 * an LLM as instructions.
 */
export function sanitizeText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return [...cleaned].slice(0, maxLength).join("");
}

/** Accept only plain https URLs without credentials. Anything else => null. */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** Convert a snapshot into the engine's observation. Non-ok metrics become null. */
export function snapshotToObservation(s: NormalizedSnapshot): Observation {
  const m = s.metrics;
  return {
    periodStart: s.observedAt - s.intervalMs,
    periodEnd: s.observedAt,
    priceUsd: metricValue(m.priceUsd),
    volumeUsd: metricValue(m.volumeUsd),
    liquidityUsd: metricValue(m.liquidityUsd),
    tradeCount: metricValue(m.tradeCount),
    buyCount: metricValue(m.buyCount),
    sellCount: metricValue(m.sellCount),
    uniqueBuyers: metricValue(m.uniqueBuyers),
    uniqueSellers: metricValue(m.uniqueSellers),
    largestTradeUsd: metricValue(m.largestTradeUsd),
    liquiditySource: `${s.provider}:${s.poolId ?? "aggregate"}`,
  };
}

export interface ProviderFetchResult {
  snapshot: NormalizedSnapshot;
  metadata: TokenMetadata | null;
  /** Non-fatal data-quality notes (e.g. one metric was invalid). */
  issues: string[];
}

export interface MarketDataProvider {
  readonly name: string;
  readonly synthetic: boolean;
  /** Throws ProviderError on failure. Never returns fabricated values. */
  fetchSnapshot(mint: string): Promise<ProviderFetchResult>;
}
