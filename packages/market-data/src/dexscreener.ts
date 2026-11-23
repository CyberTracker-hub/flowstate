import { ProviderError, parseRetryAfter, withRetry, type FailureKind, type RetryOptions } from "@flowstate/shared";
import { isValidMint } from "./base58";
import {
  MISSING,
  UNSUPPORTED,
  computeCompleteness,
  okMetric,
  readMetric,
  sanitizeText,
  type MarketDataProvider,
  type Metric,
  type MetricKey,
  type NormalizedSnapshot,
  type ProviderFetchResult,
  type TokenMetadata,
} from "./model";

/**
 * DexScreener adapter (free public API, no key).
 *
 * LIVE VERIFIED on 2026-11-23 with real requests:
 *   GET /token-pairs/v1/solana/{mint}            -> array of up to 30 pools, unordered
 *   GET /latest/dex/pairs/solana/{a,b,...}       -> { schemaVersion, pairs: [...] }, up to 30 pools
 *   - both answer with `cache-control: public, max-age=30` and CORS `*`
 *   - `priceUsd` / `priceNative` are STRINGS; everything else numeric
 *   - a volume window that rounds to $0.00 is OMITTED from `volume`, never
 *     sent as 0. Checked on 300 real pools: no window was ever present with
 *     value 0, the smallest present value was 0.01, every window without
 *     trades was absent (182 of 182 for m5), and the rare window with trades
 *     but no figure (2 of 118) sat next to dust-sized neighbours (e.g. $0.08
 *     across three trades in the hour). So "absent" means "under half a cent".
 *   - `marketCap` / `fdv` and `liquidity` are absent for some pools
 *   - pools of the same token can quote clearly different prices: an idle
 *     pool keeps its last price (seen: 0.9989 vs 0.8897 on the same token)
 *
 * DexScreener reports per POOL, not per token. To get token-level figures
 * this adapter pins a small set of the token's deepest pools and sums their
 * 5-minute volume, trade counts and liquidity. The pinned set is fixed
 * between re-pins so that sums are comparable over time. The identity of the
 * set is exposed as `poolId`; when it changes, the engine's liquidity signal
 * reports a "reporting change" instead of a false liquidity move.
 *
 * Not available from this API: unique wallets, holder counts, per-trade
 * sizes. Those metrics are reported as unsupported, never guessed.
 */

export const DEXSCREENER_BASE_URL = "https://api.dexscreener.com";
export const DEXSCREENER_PROVIDER = "dexscreener";
/** Documented maximum number of addresses per batch request. */
export const DEXSCREENER_BATCH = 30;
const INTERVAL_MS = 5 * 60_000;
const MAX_USD = 1e15;
const MAX_COUNT = 1e12;

export interface DexPool {
  pairAddress: string;
  baseMint: string;
  baseName: string | null;
  baseSymbol: string | null;
  quoteSymbol: string | null;
  dexId: string | null;
  labels: string[];
  url: string | null;
  imageUrl: string | null;
  priceUsd: Metric;
  liquidityUsd: Metric;
  marketCapUsd: Metric;
  fdvUsd: Metric;
  volumeM5: Metric;
  volumeH1: Metric;
  volumeH24: Metric;
  buysM5: Metric;
  sellsM5: Metric;
  tradesH1: Metric;
  priceChange: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  pairCreatedAt: number | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function value(m: Metric): number | null {
  return m.state === "ok" ? m.value : null;
}

/** Prices arrive as decimal strings. Anything that is not a plain positive decimal is an error. */
function readPriceString(raw: unknown): Metric {
  if (raw === undefined || raw === null) return MISSING;
  if (typeof raw !== "string" || !/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return { state: "error", code: "not_a_number" };
  return readMetric(Number(raw), { greaterThan: 0, max: MAX_USD });
}

function readChange(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && Math.abs(raw) < 1e9 ? raw : null;
}

/** Only DexScreener's own hosts are accepted for links and images. */
function dexscreenerUrl(raw: unknown, host: string): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== host || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/**
 * Validate one raw pool object. Returns null when it cannot be identified
 * (wrong chain, no valid addresses). Individual bad numbers are kept as
 * explicit error states.
 */
export function parseDexPool(raw: unknown): DexPool | null {
  if (!isRecord(raw) || raw.chainId !== "solana") return null;
  const base = raw.baseToken;
  const quote = raw.quoteToken;
  if (!isRecord(base) || !isValidMint(base.address) || !isValidMint(raw.pairAddress)) return null;
  const txns = isRecord(raw.txns) ? raw.txns : {};
  const m5 = isRecord(txns.m5) ? txns.m5 : null;
  const h1 = isRecord(txns.h1) ? txns.h1 : null;
  const volume = isRecord(raw.volume) ? raw.volume : null;
  const liquidity = isRecord(raw.liquidity) ? raw.liquidity : null;
  const change = isRecord(raw.priceChange) ? raw.priceChange : {};
  const info = isRecord(raw.info) ? raw.info : {};

  const buysM5 = m5 ? readMetric(m5.buys, { integer: true, max: MAX_COUNT }) : MISSING;
  const sellsM5 = m5 ? readMetric(m5.sells, { integer: true, max: MAX_COUNT }) : MISSING;
  // Verified provider behaviour (see the header): a window that rounds to
  // $0.00 is omitted from `volume`. With the `volume` object present, an
  // absent window is therefore a true zero. Without the object, it is unknown.
  const window = (key: string): Metric => {
    if (!volume) return MISSING;
    return volume[key] === undefined ? okMetric(0) : readMetric(volume[key], { max: MAX_USD });
  };
  const volumeM5 = window("m5");

  const h1Buys = h1 ? readMetric(h1.buys, { integer: true, max: MAX_COUNT }) : MISSING;
  const h1Sells = h1 ? readMetric(h1.sells, { integer: true, max: MAX_COUNT }) : MISSING;
  const tradesH1 =
    h1Buys.state === "ok" && h1Sells.state === "ok" ? okMetric(h1Buys.value + h1Sells.value) : MISSING;

  const labels: string[] = [];
  if (Array.isArray(raw.labels)) {
    for (const l of raw.labels.slice(0, 4)) {
      const text = sanitizeText(l, 12);
      if (text) labels.push(text);
    }
  }
  const created = raw.pairCreatedAt;
  return {
    pairAddress: raw.pairAddress as string,
    baseMint: base.address as string,
    baseName: sanitizeText(base.name, 64),
    baseSymbol: sanitizeText(base.symbol, 16),
    quoteSymbol: isRecord(quote) ? sanitizeText(quote.symbol, 16) : null,
    dexId: sanitizeText(raw.dexId, 24),
    labels,
    url: dexscreenerUrl(raw.url, "dexscreener.com"),
    imageUrl: dexscreenerUrl(info.imageUrl, "cdn.dexscreener.com"),
    priceUsd: readPriceString(raw.priceUsd),
    liquidityUsd: liquidity ? readMetric(liquidity.usd, { max: MAX_USD }) : MISSING,
    marketCapUsd: readMetric(raw.marketCap, { max: MAX_USD }),
    fdvUsd: readMetric(raw.fdv, { max: MAX_USD }),
    volumeM5,
    volumeH1: window("h1"),
    volumeH24: window("h24"),
    buysM5,
    sellsM5,
    tradesH1,
    priceChange: {
      m5: readChange(change.m5),
      h1: readChange(change.h1),
      h6: readChange(change.h6),
      h24: readChange(change.h24),
    },
    pairCreatedAt: typeof created === "number" && Number.isFinite(created) && created > 0 ? created : null,
  };
}

export interface PinOptions {
  /** Maximum number of pools summed per token. */
  maxPools: number;
  /** A pool must hold at least this much liquidity to be pinned (except the deepest one). */
  minPoolLiquidityUsd: number;
  /** ...and at least this share of the deepest pool's liquidity. */
  minShareOfDeepest: number;
}

export const DEFAULT_PIN_OPTIONS: PinOptions = { maxPools: 5, minPoolLiquidityUsd: 25_000, minShareOfDeepest: 0.05 };

/**
 * Choose the pools that represent a token: its deepest pools where the token
 * is the BASE asset (so buys and sells mean buys and sells of this token).
 * Returns pool addresses, deepest first. Empty when no pool qualifies.
 */
export function selectPools(pools: readonly DexPool[], mint: string, opts: PinOptions = DEFAULT_PIN_OPTIONS): string[] {
  const ranked = pools
    .filter((p) => p.baseMint === mint && p.liquidityUsd.state === "ok" && p.liquidityUsd.value > 0)
    .sort((a, b) => (value(b.liquidityUsd) ?? 0) - (value(a.liquidityUsd) ?? 0));
  const deepest = ranked[0];
  if (deepest === undefined) return [];
  const floor = Math.max(opts.minPoolLiquidityUsd, opts.minShareOfDeepest * (value(deepest.liquidityUsd) ?? 0));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of ranked) {
    if (out.length >= opts.maxPools) break;
    if (seen.has(p.pairAddress)) continue;
    if (out.length > 0 && (value(p.liquidityUsd) ?? 0) < floor) break;
    seen.add(p.pairAddress);
    out.push(p.pairAddress);
  }
  return out;
}

/** Short, stable identifier of a pinned pool set (order-independent). FNV-1a, not cryptographic. */
export function poolSetKey(addresses: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const ch of [...addresses].sort().join(",")) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${addresses.length}p-${hash.toString(16).padStart(8, "0")}`;
}

/** Display-only market context. Never used for scoring. */
export interface MarketContext {
  priceChangePct: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  tradesH1: number | null;
  fdvUsd: number | null;
  /** Pool the price is read from. */
  referencePool: string | null;
  pools: Array<{
    address: string;
    dexId: string | null;
    quoteSymbol: string | null;
    labels: string[];
    liquidityUsd: number | null;
    volumeH24Usd: number | null;
    url: string | null;
  }>;
}

export type AggregateResult =
  | { ok: true; snapshot: NormalizedSnapshot; metadata: TokenMetadata; context: MarketContext; issues: string[] }
  | { ok: false; issues: string[] };

/** Sum a metric over pools. Unknown in any pool => the sum is unknown (never partial). */
function sumMetric(pools: readonly DexPool[], pick: (p: DexPool) => Metric): Metric {
  let total = 0;
  for (const p of pools) {
    const m = pick(p);
    if (m.state === "error") return m;
    if (m.state !== "ok") return MISSING;
    total += m.value;
  }
  // Sums of cent-rounded figures: round away binary floating-point residue.
  return okMetric(Math.round(total * 100) / 100);
}

function sumOrNull(pools: readonly DexPool[], pick: (p: DexPool) => Metric): number | null {
  return value(sumMetric(pools, pick));
}

/**
 * Combine the pinned pools of one token into a token-level snapshot.
 *
 * `received` are the pools the provider returned this cycle. If any pinned
 * pool is absent, summed metrics are reported as missing rather than as a
 * silently smaller sum.
 */
export function aggregatePools(
  mint: string,
  pinned: readonly string[],
  received: readonly DexPool[],
  now: number,
): AggregateResult {
  if (pinned.length === 0) return { ok: false, issues: ["no pool pinned for this token"] };
  const byAddress = new Map<string, DexPool>();
  for (const p of received) if (p.baseMint === mint) byAddress.set(p.pairAddress, p);
  const present = pinned.map((a) => byAddress.get(a)).filter((p): p is DexPool => p !== undefined);
  if (present.length === 0) return { ok: false, issues: ["none of the pinned pools was returned"] };

  const issues: string[] = [];
  const complete = present.length === pinned.length;
  if (!complete) issues.push(`${pinned.length - present.length} of ${pinned.length} pinned pools missing from the response`);

  // Price comes from the most actively traded pinned pool: idle pools keep
  // stale prices. Ties and unknown volumes fall back to the deepest pool.
  const priced = present.filter((p) => p.priceUsd.state === "ok");
  const reference = [...priced].sort(
    (a, b) =>
      (value(b.volumeH24) ?? -1) - (value(a.volumeH24) ?? -1) ||
      (value(b.liquidityUsd) ?? -1) - (value(a.liquidityUsd) ?? -1),
  )[0];
  if (reference === undefined) return { ok: false, issues: ["no pinned pool reported a valid price"] };

  const summed = (pick: (p: DexPool) => Metric): Metric => (complete ? sumMetric(present, pick) : MISSING);
  const buyCount = summed((p) => p.buysM5);
  const sellCount = summed((p) => p.sellsM5);
  const metrics: Record<MetricKey, Metric> = {
    priceUsd: reference.priceUsd,
    marketCapUsd: reference.marketCapUsd,
    liquidityUsd: summed((p) => p.liquidityUsd),
    volumeUsd: summed((p) => p.volumeM5),
    tradeCount: buyCount.state === "ok" && sellCount.state === "ok" ? okMetric(buyCount.value + sellCount.value) : MISSING,
    buyCount,
    sellCount,
    uniqueBuyers: UNSUPPORTED,
    uniqueSellers: UNSUPPORTED,
    holderCount: UNSUPPORTED,
    largestTradeUsd: UNSUPPORTED,
  };
  for (const [key, metric] of Object.entries(metrics)) {
    if (metric.state === "error") issues.push(`${key}: ${metric.code}`);
  }

  const snapshot: NormalizedSnapshot = {
    chain: "solana",
    mint,
    provider: DEXSCREENER_PROVIDER,
    synthetic: false,
    // Bucket-aligned so repeated polls inside one interval are idempotent.
    observedAt: Math.floor(now / INTERVAL_MS) * INTERVAL_MS,
    intervalMs: INTERVAL_MS,
    providerTimestamp: null,
    ingestedAt: now,
    poolId: poolSetKey(pinned),
    metrics,
    completeness: computeCompleteness(metrics),
  };
  const metadata: TokenMetadata = {
    mint,
    name: reference.baseName,
    symbol: reference.baseSymbol,
    decimals: null,
    logoUrl: present.find((p) => p.imageUrl !== null)?.imageUrl ?? null,
  };
  const context: MarketContext = {
    priceChangePct: reference.priceChange,
    volumeH1Usd: complete ? sumOrNull(present, (p) => p.volumeH1) : null,
    volumeH24Usd: complete ? sumOrNull(present, (p) => p.volumeH24) : null,
    tradesH1: complete ? sumOrNull(present, (p) => p.tradesH1) : null,
    fdvUsd: value(reference.fdvUsd),
    referencePool: reference.pairAddress,
    pools: present.map((p) => ({
      address: p.pairAddress,
      dexId: p.dexId,
      quoteSymbol: p.quoteSymbol,
      labels: p.labels,
      liquidityUsd: value(p.liquidityUsd),
      volumeH24Usd: value(p.volumeH24),
      url: p.url,
    })),
  };
  return { ok: true, snapshot, metadata, context, issues };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface DexScreenerClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  retry?: RetryOptions;
}

function classifyStatus(status: number): FailureKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "client";
}

export interface DexScreenerClient {
  /** All pools DexScreener lists for a token (up to 30, unordered). */
  tokenPools(mint: string): Promise<DexPool[]>;
  /** Specific pools by address, at most DEXSCREENER_BATCH per call. */
  poolsByAddress(addresses: readonly string[]): Promise<DexPool[]>;
}

export function createDexScreenerClient(opts: DexScreenerClientOptions = {}): DexScreenerClient {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const baseUrl = (opts.baseUrl ?? DEXSCREENER_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retry: RetryOptions = opts.retry ?? { maxAttempts: 3 };

  const getJson = (path: string): Promise<unknown> =>
    withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new ProviderError(DEXSCREENER_PROVIDER, aborted ? "timeout" : "network", aborted ? "request timed out" : "network error");
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new ProviderError(DEXSCREENER_PROVIDER, classifyStatus(response.status), `HTTP ${response.status}`, {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()),
        });
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new ProviderError(DEXSCREENER_PROVIDER, "invalid_response", "response was not valid JSON", {
          status: response.status,
        });
      }
    }, retry);

  const parseList = (list: unknown): DexPool[] => {
    if (!Array.isArray(list)) {
      throw new ProviderError(DEXSCREENER_PROVIDER, "invalid_response", "expected an array of pools");
    }
    const out: DexPool[] = [];
    for (const raw of list) {
      const pool = parseDexPool(raw);
      if (pool) out.push(pool);
    }
    return out;
  };

  return {
    async tokenPools(mint) {
      if (!isValidMint(mint)) throw new ProviderError(DEXSCREENER_PROVIDER, "client", "refusing to request an invalid mint address");
      return parseList(await getJson(`/token-pairs/v1/solana/${mint}`));
    },
    async poolsByAddress(addresses) {
      if (addresses.length === 0) return [];
      if (addresses.length > DEXSCREENER_BATCH || !addresses.every((a) => isValidMint(a))) {
        throw new ProviderError(DEXSCREENER_PROVIDER, "client", "invalid pool address batch");
      }
      const body = await getJson(`/latest/dex/pairs/solana/${addresses.join(",")}`);
      // A null `pairs` means "none of these pools exist".
      if (isRecord(body) && body.pairs === null) return [];
      return parseList(isRecord(body) ? body.pairs : body);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface PoolPin {
  pools: string[];
  pinnedAt: number;
}

export interface DexScreenerProviderOptions extends DexScreenerClientOptions {
  client?: DexScreenerClient;
  /** Pinned pools per mint. Mutated in place; persist it between runs. */
  pins?: Map<string, PoolPin>;
  /** Pins older than this are re-selected. */
  repinAfterMs?: number;
  pin?: PinOptions;
}

export interface DexScreenerProvider extends MarketDataProvider {
  readonly pins: Map<string, PoolPin>;
  /**
   * Fetch everything needed for one cycle in a few batched requests.
   * Never throws: per-token failures are reported by fetchSnapshot.
   */
  prepare(mints: readonly string[]): Promise<{ requests: number; repinned: number }>;
  /** Display-only context of the most recent successful fetch of a token. */
  contextFor(mint: string): MarketContext | null;
}

type Prepared = { ok: true; result: ProviderFetchResult; context: MarketContext } | { ok: false; error: ProviderError };

function asProviderError(error: unknown): ProviderError {
  return error instanceof ProviderError
    ? error
    : new ProviderError(DEXSCREENER_PROVIDER, "invalid_response", "unexpected error while reading provider data");
}

export function createDexScreenerProvider(opts: DexScreenerProviderOptions = {}): DexScreenerProvider {
  const now = opts.now ?? Date.now;
  const client = opts.client ?? createDexScreenerClient(opts);
  const pins = opts.pins ?? new Map<string, PoolPin>();
  const repinAfterMs = opts.repinAfterMs ?? 6 * 60 * 60_000;
  const pinOptions = opts.pin ?? DEFAULT_PIN_OPTIONS;
  const prepared = new Map<string, Prepared>();
  const contexts = new Map<string, MarketContext>();

  return {
    name: DEXSCREENER_PROVIDER,
    synthetic: false,
    pins,

    async prepare(mints) {
      prepared.clear();
      let requests = 0;
      let repinned = 0;
      const unique = [...new Set(mints)];

      // 1. (Re-)pin pools where needed. One request per token, but only
      //    every `repinAfterMs`, so the steady state is a handful of batches.
      for (const mint of unique) {
        if (!isValidMint(mint)) {
          prepared.set(mint, { ok: false, error: new ProviderError(DEXSCREENER_PROVIDER, "client", "invalid mint address") });
          continue;
        }
        const pin = pins.get(mint);
        if (pin !== undefined && pin.pools.length > 0 && now() - pin.pinnedAt < repinAfterMs) continue;
        try {
          requests += 1;
          const selected = selectPools(await client.tokenPools(mint), mint, pinOptions);
          if (selected.length > 0) {
            pins.set(mint, { pools: selected, pinnedAt: now() });
            repinned += 1;
          } else if (pin === undefined) {
            prepared.set(mint, {
              ok: false,
              error: new ProviderError(DEXSCREENER_PROVIDER, "client", "no liquid pool found for this token"),
            });
          }
        } catch (error) {
          // Keep an existing pin when re-pinning fails; otherwise report the failure.
          if (pin === undefined || pin.pools.length === 0) prepared.set(mint, { ok: false, error: asProviderError(error) });
        }
      }

      // 2. Fetch all pinned pools in batches.
      const wanted: string[] = [];
      for (const mint of unique) {
        if (prepared.has(mint)) continue;
        for (const address of pins.get(mint)?.pools ?? []) wanted.push(address);
      }
      const received: DexPool[] = [];
      const failedAddresses = new Map<string, ProviderError>();
      for (let i = 0; i < wanted.length; i += DEXSCREENER_BATCH) {
        const batch = wanted.slice(i, i + DEXSCREENER_BATCH);
        try {
          requests += 1;
          received.push(...(await client.poolsByAddress(batch)));
        } catch (error) {
          const providerError = asProviderError(error);
          for (const address of batch) failedAddresses.set(address, providerError);
        }
      }

      // 3. Aggregate per token.
      const at = now();
      for (const mint of unique) {
        if (prepared.has(mint)) continue;
        const pin = pins.get(mint);
        if (pin === undefined) continue;
        const failed = pin.pools.map((a) => failedAddresses.get(a)).find((e) => e !== undefined);
        if (failed !== undefined) {
          prepared.set(mint, { ok: false, error: failed });
          continue;
        }
        const result = aggregatePools(mint, pin.pools, received, at);
        if (!result.ok) {
          // The pinned pools are gone: select again on the next cycle.
          pins.delete(mint);
          prepared.set(mint, {
            ok: false,
            error: new ProviderError(DEXSCREENER_PROVIDER, "invalid_response", `record quarantined: ${result.issues.join("; ")}`),
          });
          continue;
        }
        // An incomplete pool set is re-selected on the next cycle.
        if (result.context.pools.length < pin.pools.length) pin.pinnedAt = 0;
        contexts.set(mint, result.context);
        prepared.set(mint, {
          ok: true,
          result: { snapshot: result.snapshot, metadata: result.metadata, issues: result.issues },
          context: result.context,
        });
      }
      return { requests, repinned };
    },

    async fetchSnapshot(mint) {
      const entry = prepared.get(mint);
      if (entry === undefined) {
        throw new ProviderError(DEXSCREENER_PROVIDER, "client", "token was not prepared for this cycle");
      }
      if (!entry.ok) throw entry.error;
      return entry.result;
    },

    contextFor(mint) {
      return contexts.get(mint) ?? null;
    },
  };
}
