import { ProviderError, parseRetryAfter } from "@flowstate/shared";
import { isValidMint } from "./base58";
import {
  UNSUPPORTED,
  computeCompleteness,
  readMetric,
  safeHttpsUrl,
  sanitizeText,
  type MarketDataProvider,
  type Metric,
  type MetricKey,
  type NormalizedSnapshot,
  type ProviderFetchResult,
  type TokenMetadata,
} from "./model";

/**
 * Birdeye adapter: GET /defi/token_overview
 *
 * Verified against the official reference on 2026-11-23
 * (https://data.birdeye.so/docs/data-api/stats/get-defi-token-overview.md):
 *   - base URL https://public-api.birdeye.so, header X-API-KEY, header x-chain
 *   - query: address (required), frames (comma-separated intervals)
 *   - 18 compute units per request
 *   - fields used below: price, liquidity, marketCap, holder,
 *     lastTradeUnixTime, v{i}USD, trade{i}, buy{i}, sell{i},
 *     uniqueBuyer{i} / uniqueSeller{i} (Solana only)
 *
 * NOT verified against the live API: no API key was available when this was
 * written. See docs/integrations.md.
 *
 * This endpoint has no per-trade data, so `largestTradeUsd` is reported as
 * unsupported rather than guessed.
 */

export const BIRDEYE_BASE_URL = "https://public-api.birdeye.so";
export const BIRDEYE_OVERVIEW_COMPUTE_UNITS = 18;

const FRAME_MS = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
} as const;
export type BirdeyeFrame = keyof typeof FRAME_MS;

export interface BirdeyeOptions {
  apiKey: string;
  frame?: BirdeyeFrame;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export type NormalizeResult =
  | { ok: true; snapshot: NormalizedSnapshot; metadata: TokenMetadata; issues: string[] }
  | { ok: false; issues: string[] };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Sanity ceilings: anything above these is treated as a provider error.
const MAX_USD = 1e15;
const MAX_COUNT = 1e12;

/**
 * Turn a raw token_overview response body into a normalized snapshot.
 * Malformed records are rejected ("quarantined") with reasons; individual
 * bad metrics are kept as explicit error states.
 */
export function normalizeBirdeyeOverview(
  body: unknown,
  ctx: { mint: string; frame: BirdeyeFrame; now: number },
): NormalizeResult {
  const issues: string[] = [];
  if (!isRecord(body)) return { ok: false, issues: ["response body is not an object"] };
  if (body.success === false) return { ok: false, issues: ["provider reported success=false"] };
  const data = body.data;
  if (!isRecord(data)) return { ok: false, issues: ["response has no data object"] };
  if (typeof data.address === "string" && data.address !== ctx.mint) {
    return { ok: false, issues: ["response address does not match the requested mint"] };
  }

  const f = ctx.frame;
  const metrics: Record<MetricKey, Metric> = {
    priceUsd: readMetric(data.price, { greaterThan: 0, max: MAX_USD }),
    marketCapUsd: readMetric(data.marketCap, { max: MAX_USD }),
    liquidityUsd: readMetric(data.liquidity, { max: MAX_USD }),
    volumeUsd: readMetric(data[`v${f}USD`], { max: MAX_USD }),
    tradeCount: readMetric(data[`trade${f}`], { integer: true, max: MAX_COUNT }),
    buyCount: readMetric(data[`buy${f}`], { integer: true, max: MAX_COUNT }),
    sellCount: readMetric(data[`sell${f}`], { integer: true, max: MAX_COUNT }),
    uniqueBuyers: readMetric(data[`uniqueBuyer${f}`], { integer: true, max: MAX_COUNT }),
    uniqueSellers: readMetric(data[`uniqueSeller${f}`], { integer: true, max: MAX_COUNT }),
    holderCount: readMetric(data.holder, { integer: true, max: MAX_COUNT }),
    largestTradeUsd: UNSUPPORTED,
  };

  if (metrics.priceUsd.state === "error") {
    return { ok: false, issues: [`invalid price (${metrics.priceUsd.code})`] };
  }
  for (const [key, metric] of Object.entries(metrics)) {
    if (metric.state === "error") issues.push(`${key}: ${metric.code}`);
  }

  const intervalMs = FRAME_MS[f];
  const lastTrade = readMetric(data.lastTradeUnixTime, { max: 1e11 });
  const snapshot: NormalizedSnapshot = {
    chain: "solana",
    mint: ctx.mint,
    provider: "birdeye",
    synthetic: false,
    // Bucket-aligned so repeated polls inside one interval are idempotent.
    observedAt: Math.floor(ctx.now / intervalMs) * intervalMs,
    intervalMs,
    providerTimestamp: lastTrade.state === "ok" ? Math.round(lastTrade.value * 1000) : null,
    ingestedAt: ctx.now,
    poolId: null,
    metrics,
    completeness: computeCompleteness(metrics),
  };

  const decimals = data.decimals;
  const metadata: TokenMetadata = {
    mint: ctx.mint,
    name: sanitizeText(data.name, 64),
    symbol: sanitizeText(data.symbol, 16),
    decimals: typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null,
    logoUrl: safeHttpsUrl(data.logoURI),
  };
  return { ok: true, snapshot, metadata, issues };
}

function classifyStatus(status: number): "rate_limited" | "auth" | "server" | "client" {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "client";
}

export function createBirdeyeProvider(opts: BirdeyeOptions): MarketDataProvider {
  if (!opts.apiKey) throw new Error("Birdeye API key is required (BIRDEYE_API_KEY)");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const frame = opts.frame ?? "5m";
  const baseUrl = (opts.baseUrl ?? BIRDEYE_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    name: "birdeye",
    synthetic: false,
    async fetchSnapshot(mint: string): Promise<ProviderFetchResult> {
      if (!isValidMint(mint)) {
        throw new ProviderError("birdeye", "client", "refusing to request an invalid mint address");
      }
      const url = `${baseUrl}/defi/token_overview?address=${encodeURIComponent(mint)}&frames=${frame}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers: { "X-API-KEY": opts.apiKey, "x-chain": "solana", accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        // The error message is deliberately generic: it must never echo the
        // request (and therefore never the API key).
        throw new ProviderError("birdeye", aborted ? "timeout" : "network", aborted ? "request timed out" : "network error");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new ProviderError("birdeye", classifyStatus(response.status), `HTTP ${response.status}`, {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()),
        });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderError("birdeye", "invalid_response", "response was not valid JSON", { status: response.status });
      }
      const result = normalizeBirdeyeOverview(body, { mint, frame, now: now() });
      if (!result.ok) {
        throw new ProviderError("birdeye", "invalid_response", `record quarantined: ${result.issues.join("; ")}`, {
          status: response.status,
        });
      }
      return { snapshot: result.snapshot, metadata: result.metadata, issues: result.issues };
    },
  };
}

/**
 * Compute-unit budget for polling `tokens` tokens every `intervalSeconds`
 * with this endpoint. Use it to size the monitored universe to the plan.
 */
export function estimateMonthlyComputeUnits(tokens: number, intervalSeconds: number, days = 30): number {
  if (!(tokens > 0) || !(intervalSeconds > 0)) return 0;
  const pollsPerDay = Math.floor(86_400 / intervalSeconds);
  return Math.round(tokens) * pollsPerDay * days * BIRDEYE_OVERVIEW_COMPUTE_UNITS;
}
