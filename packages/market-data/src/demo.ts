import { ProviderError } from "@flowstate/shared";
import { base58Encode } from "./base58";
import {
  UNSUPPORTED,
  computeCompleteness,
  okMetric,
  type MarketDataProvider,
  type Metric,
  type MetricKey,
  type NormalizedSnapshot,
  type ProviderFetchResult,
  type TokenMetadata,
} from "./model";

/**
 * DEMO MODE fixtures.
 *
 * Everything in this file is synthetic and deterministic: the same seed
 * always produces the same series. Snapshots are tagged `synthetic: true`
 * and `provider: "demo"`, the tokens have obviously fake names, and the mint
 * addresses are random bytes that do not correspond to real tokens.
 * Demo data exists for local development, tests and UI previews only and
 * must always be labelled as demo data wherever it is displayed.
 */

export const DEMO_PROVIDER = "demo";
export const DEMO_BUCKET_MS = 5 * 60_000;
/** First bucket of the scripted anomaly window. */
export const DEMO_ANOMALY_START = 300;
/** Length of the scripted anomaly window, in buckets. */
export const DEMO_ANOMALY_BUCKETS = 4;

export type DemoScenario =
  | "steady"
  | "volume_spike"
  | "liquidity_pull"
  | "quiet_accumulation"
  | "thin_coverage"
  | "new_listing";

export interface DemoToken {
  index: number;
  mint: string;
  name: string;
  symbol: string;
  scenario: DemoScenario;
  basePriceUsd: number;
  baseVolumeUsd: number;
  baseLiquidityUsd: number;
  /** First bucket for which the token has data. */
  listedFromBucket: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

const SCENARIOS: ReadonlyArray<[string, string, DemoScenario]> = [
  ["Demo Steady One", "DEMO-S1", "steady"],
  ["Demo Steady Two", "DEMO-S2", "steady"],
  ["Demo Steady Three", "DEMO-S3", "steady"],
  ["Demo Volume Spike", "DEMO-VS", "volume_spike"],
  ["Demo Liquidity Pull", "DEMO-LP", "liquidity_pull"],
  ["Demo Quiet Accumulation", "DEMO-QA", "quiet_accumulation"],
  ["Demo Thin Coverage", "DEMO-TC", "thin_coverage"],
  ["Demo New Listing", "DEMO-NL", "new_listing"],
];

export function createDemoUniverse(seed = 42): DemoToken[] {
  return SCENARIOS.map(([name, symbol, scenario], index) => {
    const rng = mulberry32(mix(seed, index, 0xabc));
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(rng() * 256);
    return {
      index,
      mint: base58Encode(bytes),
      name,
      symbol,
      scenario,
      basePriceUsd: Number((0.01 + rng() * 2).toFixed(6)),
      baseVolumeUsd: 12_000,
      baseLiquidityUsd: 400_000,
      listedFromBucket: scenario === "new_listing" ? DEMO_ANOMALY_START - 4 : 0,
    };
  });
}

export interface DemoOptions {
  seed?: number;
  /** Epoch ms of the start of bucket 0. */
  startMs: number;
}

/** Deterministic snapshot for one token and one bucket. */
export function demoSnapshot(token: DemoToken, bucket: number, opts: DemoOptions): NormalizedSnapshot {
  const seed = opts.seed ?? 42;
  const u = (salt: number) => mulberry32(mix(seed, token.index, bucket, salt))();
  const around = (salt: number, spread: number) => 1 + (u(salt) * 2 - 1) * spread;
  const inWindow = bucket >= DEMO_ANOMALY_START && bucket < DEMO_ANOMALY_START + DEMO_ANOMALY_BUCKETS;
  const afterStart = bucket >= DEMO_ANOMALY_START;
  const s = token.scenario;

  let price = token.basePriceUsd * (1 + 0.004 * Math.sin(bucket / 23 + token.index)) * around(1, 0.00075);
  let volume = token.baseVolumeUsd * around(2, 0.25);
  let buys = Math.round(28 * around(3, 0.2));
  let sells = Math.round(27 * around(4, 0.2));
  let liquidity = token.baseLiquidityUsd * (1 + 0.003 * Math.sin(bucket / 40 + token.index));
  let largestShareOfVolume = 0.04 + u(5) * 0.03;

  if (s === "volume_spike") {
    if (afterStart) price *= 1.06;
    if (inWindow) {
      volume *= 9;
      buys *= 7;
      sells = Math.round(sells * 1.3);
      largestShareOfVolume = 0.25;
    }
  } else if (s === "liquidity_pull") {
    if (afterStart) liquidity *= 0.4;
    if (inWindow) {
      volume *= 4;
      sells *= 4;
      largestShareOfVolume = 0.15;
    }
  } else if (s === "quiet_accumulation") {
    if (inWindow) {
      volume *= 8;
      buys *= 5;
      sells *= 5;
    }
  } else if ((s === "thin_coverage" || s === "new_listing") && inWindow) {
    volume *= 9;
  }

  const thin = s === "thin_coverage";
  const metrics: Record<MetricKey, Metric> = {
    priceUsd: okMetric(Number(price.toPrecision(10))),
    marketCapUsd: okMetric(Math.round(price * 1_000_000_000)),
    liquidityUsd: okMetric(Math.round(liquidity)),
    volumeUsd: okMetric(Math.round(volume * 100) / 100),
    tradeCount: thin ? UNSUPPORTED : okMetric(buys + sells),
    buyCount: thin ? UNSUPPORTED : okMetric(buys),
    sellCount: thin ? UNSUPPORTED : okMetric(sells),
    uniqueBuyers: thin ? UNSUPPORTED : okMetric(Math.round(buys * 0.7)),
    uniqueSellers: thin ? UNSUPPORTED : okMetric(Math.round(sells * 0.7)),
    holderCount: okMetric(5_000 + bucket),
    largestTradeUsd: thin ? UNSUPPORTED : okMetric(Math.round(volume * largestShareOfVolume * 100) / 100),
  };

  const observedAt = opts.startMs + (bucket + 1) * DEMO_BUCKET_MS;
  return {
    chain: "solana",
    mint: token.mint,
    provider: DEMO_PROVIDER,
    synthetic: true,
    observedAt,
    intervalMs: DEMO_BUCKET_MS,
    providerTimestamp: observedAt,
    ingestedAt: observedAt,
    poolId: "demo-pool",
    metrics,
    completeness: computeCompleteness(metrics),
  };
}

export interface DemoProvider extends MarketDataProvider {
  readonly tokens: readonly DemoToken[];
  /** Mints that have data at `now`. */
  listedMints(now: number): string[];
}

/** A provider that serves the latest completed demo bucket for the injected clock. */
export function createDemoProvider(opts: DemoOptions & { now: () => number }): DemoProvider {
  const tokens = createDemoUniverse(opts.seed);
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  const latestBucket = (now: number) => Math.floor((now - opts.startMs) / DEMO_BUCKET_MS) - 1;

  return {
    name: DEMO_PROVIDER,
    synthetic: true,
    tokens,
    listedMints(now: number): string[] {
      const bucket = latestBucket(now);
      return tokens.filter((t) => bucket >= t.listedFromBucket).map((t) => t.mint);
    },
    async fetchSnapshot(mint: string): Promise<ProviderFetchResult> {
      const token = byMint.get(mint);
      if (!token) throw new ProviderError(DEMO_PROVIDER, "client", "unknown demo token");
      const bucket = latestBucket(opts.now());
      if (bucket < token.listedFromBucket) {
        throw new ProviderError(DEMO_PROVIDER, "client", "demo token has no data yet");
      }
      const metadata: TokenMetadata = {
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        decimals: 6,
        logoUrl: null,
      };
      return { snapshot: demoSnapshot(token, bucket, opts), metadata, issues: [] };
    },
  };
}
