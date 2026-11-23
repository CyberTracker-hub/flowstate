import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderError } from "@flowstate/shared";
import {
  aggregatePools,
  createDexScreenerClient,
  createDexScreenerProvider,
  parseDexPool,
  poolSetKey,
  selectPools,
  type DexPool,
  type PoolPin,
} from "./dexscreener";
import { TRUMP_MINT, TRUMP_POOLS } from "./dexscreener.fixture";
import { metricValue, snapshotToObservation } from "./model";

const NOW = Date.UTC(2026, 10, 23, 20, 3, 20);
const FIVE_MIN = 5 * 60_000;
const [P1, P2, P3, P4] = [
  "3C5YE97HADPDxZehYq9Cis8AXr9aNyrUsczKzE1nDbW9",
  "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
  "5WrgXzWiz93g4L5XBmr3ggMybW5gfL7drNAKoQMgpDHc",
  "CRoTdDUM3NJGbuvB7Vr9rhmRxnSswMjnTLC1ANjhwsdq",
] as const;

function pools(): DexPool[] {
  return TRUMP_POOLS.map((raw) => {
    const pool = parseDexPool(raw);
    assert.ok(pool, "fixture pool must parse");
    return pool;
  });
}

function clone(index: number, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...(structuredClone(TRUMP_POOLS[index]) as Record<string, unknown>), ...patch };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("DexScreener: parsing real responses", () => {
  it("parses the captured pools, with prices read from strings", () => {
    const [first] = pools();
    assert.ok(first);
    assert.equal(first.baseMint, TRUMP_MINT);
    assert.equal(first.baseSymbol, "TRUMP");
    assert.equal(first.quoteSymbol, "USDC");
    assert.equal(metricValue(first.priceUsd), 0.8897);
    assert.equal(metricValue(first.liquidityUsd), 3850658.49);
    assert.equal(metricValue(first.volumeM5), 8252.35);
    assert.equal(metricValue(first.buysM5), 17);
    assert.equal(metricValue(first.tradesH1), 233);
    assert.equal(first.priceChange.h24, -0.49);
    assert.ok(first.imageUrl?.startsWith("https://cdn.dexscreener.com/"));
  });

  it("treats an absent volume.m5 as zero only when the pool reports zero trades", () => {
    const idle = pools()[1];
    assert.ok(idle);
    assert.deepEqual(idle.volumeM5, { state: "ok", value: 0 });
    assert.equal(idle.priceChange.h24, null);

    // Trades happened but the volume figure is absent: that is unknown, not zero.
    const odd = parseDexPool(clone(1, { txns: { m5: { buys: 3, sells: 1 } } }));
    assert.deepEqual(odd?.volumeM5, { state: "missing" });
    // No txns block at all: unknown as well.
    const bare = parseDexPool(clone(1, { txns: undefined }));
    assert.deepEqual(bare?.volumeM5, { state: "missing" });
    assert.deepEqual(bare?.buysM5, { state: "missing" });
  });

  it("rejects pools it cannot identify and flags bad numbers without coercing them", () => {
    assert.equal(parseDexPool(null), null);
    assert.equal(parseDexPool(clone(0, { chainId: "ethereum" })), null);
    assert.equal(parseDexPool(clone(0, { pairAddress: "not-an-address" })), null);
    assert.equal(parseDexPool(clone(0, { baseToken: { address: "SOL" } })), null);

    const bad = parseDexPool(clone(0, { priceUsd: 0.8897, liquidity: { usd: -5 }, marketCap: "1e9" }));
    assert.ok(bad);
    assert.equal(bad.priceUsd.state, "error"); // a number where a string is documented
    assert.equal(bad.liquidityUsd.state, "error");
    assert.equal(bad.marketCapUsd.state, "error");
    assert.equal(parseDexPool(clone(0, { priceUsd: "0" }))?.priceUsd.state, "error");
    assert.equal(parseDexPool(clone(0, { priceUsd: "1.2.3" }))?.priceUsd.state, "error");
    assert.equal(parseDexPool(clone(0, { priceUsd: "NaN" }))?.priceUsd.state, "error");
  });

  it("sanitizes untrusted text and only accepts DexScreener's own hosts for links", () => {
    const pool = parseDexPool(
      clone(0, {
        baseToken: { address: TRUMP_MINT, name: "Evil‮token\u0000 <script>", symbol: "  TR​UMP  " },
        url: "https://evil.example/solana/x",
        info: { imageUrl: "javascript:alert(1)" },
        labels: ["DLMM", 7, "x".repeat(40)],
      }),
    );
    assert.ok(pool);
    assert.equal(pool.baseName, "Eviltoken <script>"); // still untrusted TEXT; rendered as text only
    assert.equal(pool.baseSymbol, "TRUMP");
    assert.equal(pool.url, null);
    assert.equal(pool.imageUrl, null);
    assert.deepEqual(pool.labels, ["DLMM", "xxxxxxxxxxxx"]);
  });
});

describe("DexScreener: pool selection", () => {
  it("pins the deepest pools above the liquidity floor, deepest first", () => {
    assert.deepEqual(selectPools(pools(), TRUMP_MINT), [P1, P2, P3, P4]);
    assert.deepEqual(selectPools(pools(), TRUMP_MINT, { maxPools: 2, minPoolLiquidityUsd: 0, minShareOfDeepest: 0 }), [P1, P2]);
    // A 20 % share floor drops the two ~$620K pools next to a $3.85M pool.
    assert.deepEqual(
      selectPools(pools(), TRUMP_MINT, { maxPools: 5, minPoolLiquidityUsd: 0, minShareOfDeepest: 0.2 }),
      [P1, P2],
    );
  });

  it("ignores pools where the token is not the base asset or liquidity is unknown", () => {
    const other = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    assert.deepEqual(selectPools(pools(), other), []);
    const noLiquidity = parseDexPool(clone(0, { liquidity: undefined }));
    assert.ok(noLiquidity);
    assert.deepEqual(selectPools([noLiquidity], TRUMP_MINT), []);
  });

  it("always keeps the deepest pool, even below the absolute floor", () => {
    const small = parseDexPool(clone(2, { liquidity: { usd: 900 } }));
    assert.ok(small);
    assert.deepEqual(selectPools([small], TRUMP_MINT), [P3]);
  });

  it("identifies a pool set independent of order", () => {
    assert.equal(poolSetKey([P1, P2]), poolSetKey([P2, P1]));
    assert.notEqual(poolSetKey([P1, P2]), poolSetKey([P1, P3]));
    assert.match(poolSetKey([P1, P2]), /^2p-[0-9a-f]{8}$/);
  });
});

describe("DexScreener: token-level aggregation", () => {
  it("sums volume, trades and liquidity over the pinned pools", () => {
    const result = aggregatePools(TRUMP_MINT, [P1, P2, P3, P4], pools(), NOW);
    assert.ok(result.ok);
    const m = result.snapshot.metrics;
    assert.equal(metricValue(m.volumeUsd), 8252.35 + 0 + 823.87 + 1340.05);
    assert.equal(metricValue(m.buyCount), 17 + 0 + 23 + 21);
    assert.equal(metricValue(m.sellCount), 7 + 0 + 8 + 8);
    assert.equal(metricValue(m.tradeCount), 84);
    assert.ok(Math.abs((metricValue(m.liquidityUsd) ?? 0) - 8700214.13) < 0.01);
    assert.equal(result.snapshot.observedAt, Math.floor(NOW / FIVE_MIN) * FIVE_MIN);
    assert.equal(result.snapshot.intervalMs, FIVE_MIN);
    assert.equal(result.snapshot.synthetic, false);
    assert.equal(result.snapshot.provider, "dexscreener");
    assert.equal(result.snapshot.poolId, poolSetKey([P1, P2, P3, P4]));
    assert.deepEqual(result.issues, []);
  });

  it("reads the price from the most traded pool, not from an idle pool with a stale price", () => {
    // Make the idle pool the DEEPEST one, so only trading activity can pick the right price.
    const idleButDeepest = parseDexPool(clone(1, { liquidity: { usd: 9_000_000 } }));
    assert.ok(idleButDeepest);
    const received = pools().map((p) => (p.pairAddress === P2 ? idleButDeepest : p));
    const result = aggregatePools(TRUMP_MINT, [P2, P1], received, NOW);
    assert.ok(result.ok);
    assert.equal(metricValue(result.snapshot.metrics.priceUsd), 0.8897);
    assert.equal(result.context.referencePool, P1);
    assert.equal(metricValue(result.snapshot.metrics.marketCapUsd), 250778694);
    assert.equal(result.context.priceChangePct.h24, -0.49);
  });

  it("reports what the API cannot supply as unsupported, so the engine never scores it", () => {
    const result = aggregatePools(TRUMP_MINT, [P1], pools(), NOW);
    assert.ok(result.ok);
    const m = result.snapshot.metrics;
    for (const key of ["uniqueBuyers", "uniqueSellers", "holderCount", "largestTradeUsd"] as const) {
      assert.equal(m[key].state, "unsupported");
    }
    const observation = snapshotToObservation(result.snapshot);
    assert.equal(observation.uniqueBuyers, null);
    assert.equal(observation.largestTradeUsd, null);
    assert.equal(observation.liquiditySource, `dexscreener:${poolSetKey([P1])}`);
    assert.equal(result.snapshot.completeness.ratio, 1);
  });

  it("never returns a partial sum: a missing pinned pool makes summed metrics unknown", () => {
    const received = pools().filter((p) => p.pairAddress !== P3);
    const result = aggregatePools(TRUMP_MINT, [P1, P2, P3, P4], received, NOW);
    assert.ok(result.ok);
    const m = result.snapshot.metrics;
    assert.deepEqual(m.volumeUsd, { state: "missing" });
    assert.deepEqual(m.liquidityUsd, { state: "missing" });
    assert.deepEqual(m.buyCount, { state: "missing" });
    assert.equal(metricValue(m.priceUsd), 0.8897); // the price is still known
    assert.equal(result.context.volumeH24Usd, null);
    assert.equal(result.issues.length, 1);
  });

  it("makes a sum unknown when one pool's figure is unknown, and keeps errors visible", () => {
    const withUnknown = [...pools().slice(1), parseDexPool(clone(0, { txns: { m5: { buys: 4, sells: 2 } }, volume: { h24: 5 } }))];
    const a = aggregatePools(TRUMP_MINT, [P1, P2], withUnknown.filter((p): p is DexPool => p !== null), NOW);
    assert.ok(a.ok);
    assert.deepEqual(a.snapshot.metrics.volumeUsd, { state: "missing" });
    assert.equal(metricValue(a.snapshot.metrics.buyCount), 4);

    const withError = [...pools().slice(1), parseDexPool(clone(0, { liquidity: { usd: -1 } }))];
    const b = aggregatePools(TRUMP_MINT, [P1, P2], withError.filter((p): p is DexPool => p !== null), NOW);
    assert.ok(b.ok);
    assert.equal(b.snapshot.metrics.liquidityUsd.state, "error");
    assert.ok(b.issues.some((i) => i.startsWith("liquidityUsd")));
  });

  it("quarantines a token with no pinned pool in the response or no valid price", () => {
    assert.equal(aggregatePools(TRUMP_MINT, [], pools(), NOW).ok, false);
    assert.equal(aggregatePools(TRUMP_MINT, [P1], [], NOW).ok, false);
    const noPrice = parseDexPool(clone(0, { priceUsd: undefined }));
    assert.ok(noPrice);
    assert.equal(aggregatePools(TRUMP_MINT, [P1], [noPrice], NOW).ok, false);
  });
});

describe("DexScreener: client and provider", () => {
  const noSleep = { maxAttempts: 3, sleep: async () => {}, rng: () => 0 };

  it("requests the documented endpoints and unwraps both response envelopes", async () => {
    const urls: string[] = [];
    const client = createDexScreenerClient({
      fetch: (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        return url.includes("/token-pairs/") ? jsonResponse(TRUMP_POOLS) : jsonResponse({ schemaVersion: "1.0.0", pairs: TRUMP_POOLS.slice(0, 2) });
      }) as typeof fetch,
    });
    assert.equal((await client.tokenPools(TRUMP_MINT)).length, 4);
    assert.equal((await client.poolsByAddress([P1, P2])).length, 2);
    assert.deepEqual(urls, [
      `https://api.dexscreener.com/token-pairs/v1/solana/${TRUMP_MINT}`,
      `https://api.dexscreener.com/latest/dex/pairs/solana/${P1},${P2}`,
    ]);
  });

  it("classifies failures, retries transient ones and never requests an invalid address", async () => {
    let calls = 0;
    const flaky = createDexScreenerClient({
      retry: noSleep,
      fetch: (async () => {
        calls += 1;
        return calls < 3 ? jsonResponse({}, 503) : jsonResponse(TRUMP_POOLS);
      }) as typeof fetch,
    });
    assert.equal((await flaky.tokenPools(TRUMP_MINT)).length, 4);
    assert.equal(calls, 3);

    const limited = createDexScreenerClient({ retry: { ...noSleep, maxAttempts: 1 }, fetch: (async () => jsonResponse({}, 429, { "retry-after": "7" })) as typeof fetch });
    await assert.rejects(limited.tokenPools(TRUMP_MINT), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limited" && e.retryAfterMs === 7000);

    const html = createDexScreenerClient({ retry: noSleep, fetch: (async () => new Response("<html>", { status: 200 })) as typeof fetch });
    await assert.rejects(html.tokenPools(TRUMP_MINT), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_response");

    const notArray = createDexScreenerClient({ retry: noSleep, fetch: (async () => jsonResponse({ error: "nope" })) as typeof fetch });
    await assert.rejects(notArray.tokenPools(TRUMP_MINT), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_response");

    let touched = false;
    const guarded = createDexScreenerClient({
      fetch: (async () => {
        touched = true;
        return jsonResponse([]);
      }) as typeof fetch,
    });
    await assert.rejects(guarded.tokenPools("../../etc/passwd"), (e: unknown) => e instanceof ProviderError && e.kind === "client");
    await assert.rejects(guarded.poolsByAddress([P1, "x,y"]), (e: unknown) => e instanceof ProviderError && e.kind === "client");
    assert.equal(touched, false);
    assert.deepEqual(await guarded.poolsByAddress([]), []);
  });

  function fakeApi(state: { poolList: unknown[]; batchStatus?: number }) {
    const calls = { tokenPools: 0, batches: 0 };
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/token-pairs/")) {
        calls.tokenPools += 1;
        return jsonResponse(url.endsWith(TRUMP_MINT) ? state.poolList : []);
      }
      calls.batches += 1;
      if (state.batchStatus) return jsonResponse({}, state.batchStatus);
      const wanted = new Set(url.slice(url.lastIndexOf("/") + 1).split(","));
      return jsonResponse({ schemaVersion: "1.0.0", pairs: state.poolList.filter((p) => wanted.has((p as { pairAddress: string }).pairAddress)) });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("pins pools once, then serves each cycle from batched pool requests", async () => {
    let clock = NOW;
    const api = fakeApi({ poolList: TRUMP_POOLS });
    const pins = new Map<string, PoolPin>();
    const provider = createDexScreenerProvider({ fetch: api.fetchImpl, now: () => clock, pins, retry: noSleep });

    assert.deepEqual(await provider.prepare([TRUMP_MINT]), { requests: 2, repinned: 1 });
    assert.deepEqual(pins.get(TRUMP_MINT)?.pools, [P1, P2, P3, P4]);
    const first = await provider.fetchSnapshot(TRUMP_MINT);
    assert.equal(metricValue(first.snapshot.metrics.buyCount), 61);
    assert.equal(first.metadata?.symbol, "TRUMP");
    assert.equal(provider.contextFor(TRUMP_MINT)?.pools.length, 4);

    clock += FIVE_MIN;
    assert.deepEqual(await provider.prepare([TRUMP_MINT]), { requests: 1, repinned: 0 });
    assert.equal((await provider.fetchSnapshot(TRUMP_MINT)).snapshot.observedAt, first.snapshot.observedAt + FIVE_MIN);

    clock += 7 * 60 * 60_000; // past the re-pin age
    assert.deepEqual(await provider.prepare([TRUMP_MINT]), { requests: 2, repinned: 1 });
    assert.deepEqual(api.calls, { tokenPools: 2, batches: 3 });
  });

  it("reports per-token failures through fetchSnapshot and never invents a snapshot", async () => {
    const unknownMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const api = fakeApi({ poolList: TRUMP_POOLS });
    const provider = createDexScreenerProvider({ fetch: api.fetchImpl, now: () => NOW, retry: noSleep });
    await provider.prepare([TRUMP_MINT, unknownMint, "bad mint"]);
    assert.equal((await provider.fetchSnapshot(TRUMP_MINT)).snapshot.mint, TRUMP_MINT);
    await assert.rejects(provider.fetchSnapshot(unknownMint), (e: unknown) => e instanceof ProviderError && e.kind === "client");
    await assert.rejects(provider.fetchSnapshot("bad mint"), (e: unknown) => e instanceof ProviderError && e.kind === "client");
    await assert.rejects(provider.fetchSnapshot("never-prepared"), ProviderError);
    assert.equal(provider.contextFor(unknownMint), null);
  });

  it("surfaces a failed batch as that failure kind and keeps the pins for the next cycle", async () => {
    const state: { poolList: unknown[]; batchStatus?: number } = { poolList: TRUMP_POOLS };
    const api = fakeApi(state);
    const provider = createDexScreenerProvider({ fetch: api.fetchImpl, now: () => NOW, retry: noSleep });
    await provider.prepare([TRUMP_MINT]);
    state.batchStatus = 503;
    await provider.prepare([TRUMP_MINT]);
    await assert.rejects(provider.fetchSnapshot(TRUMP_MINT), (e: unknown) => e instanceof ProviderError && e.kind === "server");
    assert.equal(provider.pins.get(TRUMP_MINT)?.pools.length, 4);
    delete state.batchStatus;
    await provider.prepare([TRUMP_MINT]);
    assert.equal((await provider.fetchSnapshot(TRUMP_MINT)).snapshot.mint, TRUMP_MINT);
  });

  it("re-selects pools after a pinned pool disappears", async () => {
    const state = { poolList: TRUMP_POOLS as unknown[] };
    const api = fakeApi(state);
    const provider = createDexScreenerProvider({ fetch: api.fetchImpl, now: () => NOW, retry: noSleep });
    await provider.prepare([TRUMP_MINT]);
    state.poolList = TRUMP_POOLS.slice(0, 3);
    await provider.prepare([TRUMP_MINT]);
    const partial = await provider.fetchSnapshot(TRUMP_MINT);
    assert.deepEqual(partial.snapshot.metrics.volumeUsd, { state: "missing" });
    const before = api.calls.tokenPools;
    await provider.prepare([TRUMP_MINT]);
    assert.equal(api.calls.tokenPools, before + 1);
    assert.deepEqual(provider.pins.get(TRUMP_MINT)?.pools, [P1, P2, P3]);
    assert.equal(metricValue((await provider.fetchSnapshot(TRUMP_MINT)).snapshot.metrics.buyCount), 40);
  });
});
