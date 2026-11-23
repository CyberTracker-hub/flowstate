import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, DEFAULT_LIFECYCLE, validateConfig, type EngineConfig } from "@flowstate/anomaly-engine";
import {
  DEMO_ANOMALY_START,
  DEMO_BUCKET_MS,
  DEXSCREENER_PROVIDER,
  createDemoProvider,
  createDexScreenerProvider,
  isValidMint,
  type DexScreenerProviderOptions,
} from "@flowstate/market-data";
import type { PublicSource } from "@flowstate/shared";
import { JsonStateStore, readPersistedState, type PersistedState } from "./json-store";
import { silentLogger, type Logger } from "./logger";
import { runCycle, type CycleSummary } from "./pipeline";
import { buildPublicData, type MonitoredToken, type PublicData } from "./publish";

/**
 * The free, static deployment: one ingestion + detection cycle against the
 * DexScreener public API, with state carried in a JSON document instead of
 * a database. Run on a schedule (GitHub Actions); see docs/deployment.md.
 */

/**
 * Engine parameters for live DexScreener data.
 *
 * ASSUMPTION (not tuned on outcomes): the materiality floors are raised from
 * the defaults so that a jump from "almost nothing" to "very little" on a
 * quiet token does not read as a large multiple. A 5-minute volume baseline
 * is never taken to be below $1,000, a buy-count baseline never below 5.
 * Any change here must change `version`.
 */
export const LIVE_ENGINE: EngineConfig = {
  ...DEFAULT_CONFIG,
  version: "fs-score-1.0.0+dex.1",
  volume: { ...DEFAULT_CONFIG.volume, minBaselineUsd: 1_000 },
  buyers: { ...DEFAULT_CONFIG.buyers, minBaselineCount: 5 },
};
validateConfig(LIVE_ENGINE);

export const DEXSCREENER_SOURCE: PublicSource = {
  provider: DEXSCREENER_PROVIDER,
  name: "DexScreener",
  url: "https://dexscreener.com",
  intervalMs: 5 * 60_000,
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Validate config/tokens.json. Throws with every problem listed. */
export function parseTokenConfig(raw: unknown): MonitoredToken[] {
  if (!isRecord(raw) || !Array.isArray(raw.tokens)) throw new Error('token config must be an object with a "tokens" array');
  const problems: string[] = [];
  const seen = new Set<string>();
  const out: MonitoredToken[] = [];
  raw.tokens.forEach((entry, index) => {
    if (!isRecord(entry) || !isValidMint(entry.mint)) {
      problems.push(`tokens[${index}]: mint is not a valid Solana address`);
      return;
    }
    if (typeof entry.symbol !== "string" || !/^[A-Za-z0-9$._-]{1,12}$/.test(entry.symbol)) {
      problems.push(`tokens[${index}]: symbol must be 1-12 characters (letters, digits, $ . _ -)`);
      return;
    }
    if (seen.has(entry.mint as string)) {
      problems.push(`tokens[${index}]: duplicate mint`);
      return;
    }
    seen.add(entry.mint as string);
    out.push({ mint: entry.mint as string, symbol: entry.symbol });
  });
  if (out.length === 0) problems.push("no tokens configured");
  if (out.length > 150) problems.push("more than 150 tokens: split the list or raise the limit deliberately");
  if (problems.length > 0) throw new Error(`Invalid token config: ${problems.join("; ")}`);
  return out;
}

export interface LiveCycleOptions {
  tokens: readonly MonitoredToken[];
  /** Raw contents of the previous state.json, or null on the first run. */
  previousState: unknown;
  now?: () => number;
  newId?: () => string;
  logger?: Logger;
  provider?: Pick<DexScreenerProviderOptions, "fetch" | "retry" | "timeoutMs" | "client" | "repinAfterMs">;
}

export interface LiveCycleResult {
  state: PersistedState;
  data: PublicData;
  summary: CycleSummary;
  requests: number;
  startedFresh: boolean;
}

function countKinds(summary: CycleSummary): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const f of summary.failures) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  return kinds;
}

export async function runLiveCycle(opts: LiveCycleOptions): Promise<LiveCycleResult> {
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? silentLogger;
  const previous = readPersistedState(opts.previousState, { provider: DEXSCREENER_PROVIDER });
  if (opts.previousState !== null && previous === null) {
    log.warn("previous state was not usable (schema or provider changed); starting from empty");
  }
  const store = new JsonStateStore({ provider: DEXSCREENER_PROVIDER, synthetic: false }, previous);
  const provider = createDexScreenerProvider({ ...opts.provider, now, pins: store.pins });
  const mints = opts.tokens.map((t) => t.mint);

  const prepared = await provider.prepare(mints);
  const summary = await runCycle(mints, {
    provider,
    store,
    now,
    newId: opts.newId ?? randomUUID,
    engine: LIVE_ENGINE,
    lifecycle: DEFAULT_LIFECYCLE,
    // Data was already fetched (with retries) in prepare(); nothing to retry here.
    retry: { maxAttempts: 1 },
    logger: log,
  });

  for (const mint of mints) {
    const context = provider.contextFor(mint);
    if (context) store.contexts.set(mint, context);
  }
  const at = now();
  store.recordCycle({
    at,
    tokens: summary.tokens,
    ok: summary.tokens - summary.failures.length,
    failed: summary.failures.length,
    failureKinds: countKinds(summary),
    requests: prepared.requests,
  });
  store.prune(at, DEFAULT_LIFECYCLE);

  const data = buildPublicData({
    store,
    tokens: opts.tokens,
    now: at,
    engine: LIVE_ENGINE,
    lifecycle: DEFAULT_LIFECYCLE,
    source: DEXSCREENER_SOURCE,
  });
  return { state: store.toJSON(at), data, summary, requests: prepared.requests, startedFresh: previous === null };
}

export interface DemoReplayOptions {
  /** The replay ends at this time, so the page shows the scripted anomalies as current. */
  now: number;
  /** Number of 5-minute buckets to replay. Default stops inside the anomaly window. */
  buckets?: number;
  seed?: number;
}

/**
 * Synthetic preview: replays the deterministic demo universe through the
 * same store and publisher as live mode. Everything it produces is flagged
 * `synthetic: true`, which the website turns into a visible banner.
 */
export async function runDemoReplay(opts: DemoReplayOptions): Promise<{ state: PersistedState; data: PublicData }> {
  const buckets = opts.buckets ?? DEMO_ANOMALY_START + 3;
  const end = Math.floor(opts.now / DEMO_BUCKET_MS) * DEMO_BUCKET_MS;
  const startMs = end - (buckets + 1) * DEMO_BUCKET_MS;
  let clock = startMs;
  const provider = createDemoProvider({ seed: opts.seed, startMs, now: () => clock });
  const store = new JsonStateStore({ provider: provider.name, synthetic: true });
  let nextId = 0;
  for (let bucket = 0; bucket < buckets; bucket++) {
    clock = startMs + (bucket + 1) * DEMO_BUCKET_MS + 1_000;
    const summary = await runCycle(provider.listedMints(clock), {
      provider,
      store,
      now: () => clock,
      newId: () => `demo-event-${++nextId}`,
    });
    store.recordCycle({
      at: clock,
      tokens: summary.tokens,
      ok: summary.tokens - summary.failures.length,
      failed: summary.failures.length,
      failureKinds: countKinds(summary),
      requests: null,
    });
    store.prune(clock);
  }
  const data = buildPublicData({
    store,
    tokens: provider.tokens.filter((t) => store.series.has(t.mint)).map((t) => ({ mint: t.mint, symbol: t.symbol })),
    now: clock,
    engine: DEFAULT_CONFIG,
    lifecycle: DEFAULT_LIFECYCLE,
    source: { provider: provider.name, name: "Synthetic demo data", url: null, intervalMs: DEMO_BUCKET_MS },
  });
  return { state: store.toJSON(clock), data };
}
