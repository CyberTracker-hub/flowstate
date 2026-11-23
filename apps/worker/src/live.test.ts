import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LIFECYCLE } from "@flowstate/anomaly-engine";
import { poolSetKey } from "@flowstate/market-data";
import { PUBLIC_SCHEMA } from "@flowstate/shared";
import { JsonStateStore, readPersistedState, type PersistedState } from "./json-store";
import { LIVE_ENGINE, parseTokenConfig, runDemoReplay, runLiveCycle } from "./live";
import { buildPublicData } from "./publish";

const FIVE_MIN = 5 * 60_000;
const START = Date.UTC(2026, 10, 23, 12, 0, 0);
const SOL = "So11111111111111111111111111111111111111112";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_A = "3C5YE97HADPDxZehYq9Cis8AXr9aNyrUsczKzE1nDbW9";
const POOL_B = "5WrgXzWiz93g4L5XBmr3ggMybW5gfL7drNAKoQMgpDHc";
const POOL_J = "CRoTdDUM3NJGbuvB7Vr9rhmRxnSswMjnTLC1ANjhwsdq";
const TOKENS = [
  { mint: SOL, symbol: "SOL" },
  { mint: JUP, symbol: "JUP" },
];

interface PoolSpec {
  address: string;
  mint: string;
  name: string;
  price: number;
  liquidity: number;
  volume: number;
  buys: number;
  sells: number;
}

/** A tiny DexScreener stand-in with the verified response shapes. */
function fakeDexScreener() {
  const world = {
    down: false as boolean | number,
    requests: [] as string[],
    pools: [
      { address: POOL_A, mint: SOL, name: "Wrapped SOL", price: 72.5, liquidity: 9_000_000, volume: 40_000, buys: 60, sells: 55 },
      { address: POOL_B, mint: SOL, name: "Wrapped SOL", price: 72.4, liquidity: 3_000_000, volume: 12_000, buys: 22, sells: 20 },
      { address: POOL_J, mint: JUP, name: "Jupiter", price: 0.24, liquidity: 1_500_000, volume: 6_000, buys: 15, sells: 14 },
    ] as PoolSpec[],
  };
  const body = (p: PoolSpec) => ({
    chainId: "solana",
    dexId: "orca",
    url: `https://dexscreener.com/solana/${p.address.toLowerCase()}`,
    pairAddress: p.address,
    baseToken: { address: p.mint, name: p.name, symbol: p.name.slice(0, 3).toUpperCase() },
    quoteToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
    priceNative: String(p.price),
    priceUsd: String(p.price),
    txns: { m5: { buys: p.buys, sells: p.sells }, h1: { buys: p.buys * 12, sells: p.sells * 12 } },
    // Verified behaviour: a window that rounds to $0.00 is omitted. A negative
    // spec value stands for "no volume object at all".
    ...(p.volume < 0 ? {} : { volume: p.volume > 0 ? { m5: p.volume, h1: p.volume * 12, h24: p.volume * 288 } : { h24: 1000 } }),
    priceChange: { m5: 0.1, h1: -0.4, h6: 1.2, h24: 3.3 },
    liquidity: { usd: p.liquidity },
    marketCap: p.price * 1e9,
    fdv: p.price * 2e9,
    pairCreatedAt: 1_700_000_000_000,
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    world.requests.push(url);
    if (world.down) return json({}, typeof world.down === "number" ? world.down : 503);
    const tail = url.slice(url.lastIndexOf("/") + 1);
    if (url.includes("/token-pairs/")) return json(world.pools.filter((p) => p.mint === tail).map(body));
    const wanted = new Set(tail.split(","));
    return json({ schemaVersion: "1.0.0", pairs: world.pools.filter((p) => wanted.has(p.address)).map(body) });
  }) as typeof fetch;
  return { world, fetchImpl };
}

function harness() {
  const api = fakeDexScreener();
  let clock = START + 20_000;
  let stateText: string | null = null;
  let ids = 0;
  const step = async (advance = true) => {
    if (advance) clock += FIVE_MIN;
    const result = await runLiveCycle({
      tokens: TOKENS,
      // Round-trip through text, exactly like state.json between two runs.
      previousState: stateText === null ? null : (JSON.parse(stateText) as unknown),
      now: () => clock,
      newId: () => `evt-${++ids}`,
      provider: { fetch: api.fetchImpl, retry: { maxAttempts: 2, sleep: async () => {}, rng: () => 0 } },
    });
    stateText = JSON.stringify(result.state);
    return result;
  };
  /** Small deterministic wobble so baselines have a realistic spread. */
  const wobble = (i: number) => {
    const sol = api.world.pools[0];
    const jup = api.world.pools[2];
    assert.ok(sol && jup);
    sol.volume = 40_000 + ((i * 7919) % 9) * 900;
    sol.buys = 58 + (i % 5);
    sol.sells = 54 + ((i * 3) % 5);
    jup.volume = 6_000 + ((i * 104729) % 7) * 250;
    jup.buys = 14 + (i % 4);
    jup.sells = 13 + ((i * 5) % 4);
    jup.price = 0.24 * (1 + ((i % 3) - 1) * 0.0005);
  };
  return { api, step, wobble, clock: () => clock, state: () => JSON.parse(stateText ?? "null") as PersistedState };
}

describe("token config", () => {
  it("accepts the shipped list shape and rejects bad entries with every problem listed", () => {
    assert.deepEqual(parseTokenConfig({ _comment: "x", tokens: TOKENS }), TOKENS);
    assert.throws(() => parseTokenConfig({ tokens: [] }), /no tokens configured/);
    assert.throws(() => parseTokenConfig([]), /"tokens" array/);
    assert.throws(
      () => parseTokenConfig({ tokens: [{ mint: "SOL", symbol: "SOL" }, { mint: SOL, symbol: "<b>" }, TOKENS[0], TOKENS[0]] }),
      (e: unknown) => e instanceof Error && /tokens\[0\]: mint/.test(e.message) && /tokens\[1\]: symbol/.test(e.message) && /tokens\[3\]: duplicate/.test(e.message),
    );
  });

  it("ships a valid monitored-token list", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(new URL("../../../config/tokens.json", import.meta.url), "utf8")) as unknown;
    const tokens = parseTokenConfig(raw);
    assert.ok(tokens.length >= 30);
    assert.equal(tokens[0]?.mint, SOL);
  });
});

describe("live cycle against a DexScreener-shaped API", () => {
  it("pins pools once, then needs one batched request per cycle", async () => {
    const h = harness();
    const first = await h.step();
    assert.equal(first.startedFresh, true);
    assert.equal(first.requests, 3); // 2 pool selections + 1 batch
    assert.equal(first.summary.snapshotsSaved, 2);
    assert.deepEqual(h.state().pins[SOL]?.pools, [POOL_A, POOL_B]);
    const second = await h.step();
    assert.equal(second.startedFresh, false);
    assert.equal(second.requests, 1);
    assert.ok(h.api.world.requests.at(-1)?.includes("/latest/dex/pairs/solana/"));
  });

  it("publishes token-level sums and shows a baseline being built before any score", async () => {
    const h = harness();
    let result = await h.step();
    const sol = result.data.overview.tokens.find((t) => t.mint === SOL);
    assert.ok(sol);
    assert.equal(sol.symbol, "SOL");
    assert.equal(sol.name, "Wrapped SOL");
    assert.equal(sol.priceUsd, 72.5); // from the more traded pool
    assert.equal(sol.liquidityUsd, 12_000_000);
    assert.equal(sol.volume5mUsd, 52_000);
    assert.equal(sol.buys5m, 82);
    assert.equal(sol.change.h24, 3.3);
    assert.equal(sol.poolCount, 2);
    assert.deepEqual(sol.pools, [POOL_A, POOL_B]); // lets the website refresh these pools itself
    assert.equal(sol.samples, 1);
    assert.equal(sol.status, "insufficient_data");
    assert.equal(sol.score, null);
    assert.equal(result.data.overview.synthetic, false);
    assert.equal(result.data.overview.source.provider, "dexscreener");
    assert.equal(result.data.overview.engine.version, LIVE_ENGINE.version);
    assert.equal(result.data.overview.health.status, "ok");

    for (let i = 0; i < 13; i++) {
      h.wobble(i);
      result = await h.step();
    }
    const scored = result.data.overview.tokens.find((t) => t.mint === SOL);
    assert.equal(scored?.status, "scored");
    assert.equal(scored?.severity, "normal");
    assert.equal(scored?.coverage, 0.85); // large-transaction signal is unsupported by this source
    assert.equal(result.data.overview.events.length, 0);
  });

  it("turns a real burst into ONE event, keeps it across runs, and resolves it afterwards", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) {
      h.wobble(i);
      await h.step();
    }
    const jup = h.api.world.pools[2];
    assert.ok(jup);
    Object.assign(jup, { volume: 90_000, buys: 190, sells: 40 });
    const burst = await h.step();
    assert.equal(burst.summary.eventsCreated, 1);
    const [event] = burst.data.overview.events;
    assert.ok(event);
    assert.equal(event.symbol, "JUP");
    assert.equal(event.status, "detected");
    assert.ok(event.score >= 50, `score ${event.score}`);
    assert.match(event.summary ?? "", /5-minute volume \$90\.00K is \d+\.\dx the typical/);
    assert.equal(event.evidence?.scoreVersion, LIVE_ENGINE.version);
    assert.equal(burst.data.overview.tokens.find((t) => t.mint === JUP)?.openEventId, event.id);
    assert.equal(burst.data.overview.tokens.find((t) => t.mint === SOL)?.openEventId, null);

    const detail = burst.data.details.get(JUP);
    assert.ok(detail);
    assert.equal(detail.events[0]?.transitions[0]?.to, "detected");
    assert.equal(detail.series.t.length, 31);
    assert.equal(detail.series.volume.at(-1), 90_000);
    assert.equal(detail.series.score.at(-1), event.score);
    assert.equal(detail.detection?.dominantFactor, "volume");
    assert.equal(detail.pools[0]?.address, POOL_J);

    Object.assign(jup, { volume: 85_000, buys: 170, sells: 45 });
    const sustained = await h.step();
    assert.equal(sustained.summary.eventsCreated, 0);
    assert.equal(sustained.data.overview.events.length, 1);
    assert.equal(sustained.data.overview.events[0]?.id, event.id);

    let last = sustained;
    for (let i = 0; i < 6; i++) {
      h.wobble(i);
      last = await h.step();
    }
    assert.equal(last.data.overview.events.length, 1);
    assert.equal(last.data.overview.events[0]?.status, "resolved");
    assert.equal(last.data.overview.tokens.find((t) => t.mint === JUP)?.openEventId, null);
  });

  it("is idempotent when two runs land in the same 5-minute bucket", async () => {
    const h = harness();
    await h.step();
    const again = await h.step(false);
    assert.equal(again.summary.snapshotsSaved, 0);
    assert.equal(again.summary.alreadyProcessed, 2);
    assert.equal(h.state().series[SOL]?.length, 1);
  });

  it("reports an outage honestly, keeps the last known readings and recovers", async () => {
    const h = harness();
    await h.step();
    const before = h.state().series[SOL]?.length;
    h.api.world.down = 503;
    const outage = await h.step();
    assert.equal(outage.summary.failures.length, 2);
    assert.equal(outage.data.overview.health.status, "down");
    assert.deepEqual(outage.data.overview.health.failureKinds, { server: 2 });
    assert.equal(outage.data.overview.health.lastSuccessAt, START + 20_000 + FIVE_MIN);
    assert.equal(h.state().series[SOL]?.length, before); // nothing invented
    const stale = outage.data.overview.tokens.find((t) => t.mint === SOL);
    assert.equal(stale?.priceUsd, 72.5);
    assert.ok((stale?.observedAt ?? 0) < outage.data.overview.generatedAt - FIVE_MIN);

    h.api.world.down = false;
    const back = await h.step();
    assert.equal(back.data.overview.health.status, "ok");
    assert.equal(h.state().series[SOL]?.length, (before ?? 0) + 1);
  });

  it("marks a partial failure as degraded: a token with no pools fails alone", async () => {
    const api = fakeDexScreener();
    api.world.pools = api.world.pools.filter((p) => p.mint !== JUP);
    const result = await runLiveCycle({ tokens: TOKENS, previousState: null, now: () => START, provider: { fetch: api.fetchImpl } });
    assert.equal(result.data.overview.health.status, "degraded");
    assert.deepEqual(result.summary.failures, [{ mint: JUP, kind: "client" }]);
    const jup = result.data.overview.tokens.find((t) => t.mint === JUP);
    assert.equal(jup?.status, "no_data");
    assert.equal(jup?.priceUsd, null);
    assert.equal(jup?.samples, 0);
  });

  it("treats an omitted volume window as zero but a missing volume object as unknown", async () => {
    const h = harness();
    const jup = h.api.world.pools[2];
    assert.ok(jup);
    Object.assign(jup, { volume: 0, buys: 0, sells: 0 });
    const idle = await h.step();
    assert.equal(idle.data.overview.tokens.find((t) => t.mint === JUP)?.volume5mUsd, 0);
    Object.assign(jup, { volume: -1, buys: 3, sells: 1 }); // no volume object in the response
    const unknown = await h.step();
    const token = unknown.data.overview.tokens.find((t) => t.mint === JUP);
    assert.equal(token?.volume5mUsd, null);
    assert.equal(token?.buys5m, 3);
  });

  it("starts from empty instead of mixing sources when the saved state is from another provider", async () => {
    const demo = await runDemoReplay({ now: START, buckets: 20 });
    const api = fakeDexScreener();
    const result = await runLiveCycle({ tokens: TOKENS, previousState: demo.state, now: () => START, provider: { fetch: api.fetchImpl } });
    assert.equal(result.startedFresh, true);
    assert.deepEqual(Object.keys(result.state.series).sort(), [JUP, SOL].sort());
    assert.equal(readPersistedState({ ...result.state, schema: 99 }, { provider: "dexscreener" }), null);
    assert.equal(readPersistedState("garbage", { provider: "dexscreener" }), null);
  });
});

describe("JSON state store", () => {
  it("bounds its size and expires events that can no longer be evaluated", async () => {
    const store = new JsonStateStore({ provider: "dexscreener", synthetic: false, maxRows: 5, maxClosedEvents: 1 });
    for (let i = 0; i < 9; i++) {
      await store.saveSnapshot({
        chain: "solana",
        mint: SOL,
        provider: "dexscreener",
        synthetic: false,
        observedAt: START + i * FIVE_MIN,
        intervalMs: FIVE_MIN,
        providerTimestamp: null,
        ingestedAt: START + i * FIVE_MIN,
        poolId: poolSetKey([POOL_A]),
        metrics: {
          priceUsd: { state: "ok", value: 70 + i },
          marketCapUsd: { state: "missing" },
          liquidityUsd: { state: "ok", value: 1e6 },
          volumeUsd: { state: "error", code: "not_finite" },
          tradeCount: { state: "ok", value: 9 },
          buyCount: { state: "ok", value: 5 },
          sellCount: { state: "ok", value: 4 },
          uniqueBuyers: { state: "unsupported" },
          uniqueSellers: { state: "unsupported" },
          holderCount: { state: "unsupported" },
          largestTradeUsd: { state: "unsupported" },
        },
        completeness: { supported: 7, ok: 5, ratio: 0.7143 },
      });
    }
    const base = {
      mint: SOL,
      anomalyType: "volume",
      score: 60,
      severity: "unusual",
      peakScore: 60,
      peakSeverity: "unusual",
      updatedAt: START,
      belowThresholdSince: null,
      lastNotifiedAt: null,
      lastNotifiedSeverity: null,
      updateCount: 0,
    } as const;
    await store.saveEvent({ ...base, eventId: "old", status: "resolved", detectedAt: START - 1000, lastEvaluatedAt: START, resolvedAt: START }, null, null);
    await store.saveEvent({ ...base, eventId: "newer", status: "resolved", detectedAt: START, lastEvaluatedAt: START, resolvedAt: START + 1 }, null, null);
    await store.saveEvent({ ...base, eventId: "open", status: "active", detectedAt: START, lastEvaluatedAt: START, resolvedAt: null }, null, null);
    assert.equal((await store.getOpenEvent(SOL))?.eventId, "open");

    const now = START + 9 * FIVE_MIN + DEFAULT_LIFECYCLE.expireAfterMs;
    assert.deepEqual(store.prune(now), { expired: 1 });
    assert.equal(store.series.get(SOL)?.length, 5);
    assert.equal(await store.getOpenEvent(SOL), null);
    assert.equal(store.events.get("open")?.status, "expired");
    assert.equal(store.transitions.get("open")?.at(-1)?.reason, "no_usable_data");
    assert.deepEqual([...store.events.keys()].sort(), ["open"]); // only the most recently closed is kept

    // Unknown stays unknown through a save/load round trip.
    const reloaded = new JsonStateStore({ provider: "dexscreener", synthetic: false }, readPersistedState(JSON.parse(JSON.stringify(store.toJSON(now))), { provider: "dexscreener" }));
    const history = await reloaded.getHistory(SOL, Number.MAX_SAFE_INTEGER, 100);
    assert.equal(history.length, 5);
    assert.equal(history[0]?.volumeUsd, null);
    assert.equal(history[0]?.uniqueBuyers, null);
    assert.equal(history[0]?.tradeCount, 9);
    assert.equal(history.at(-1)?.priceUsd, 78);
    assert.equal(history[0]?.liquiditySource, `dexscreener:${poolSetKey([POOL_A])}`);
    await assert.rejects(reloaded.saveSnapshot({ provider: "demo" } as never), /cannot be stored/);
    assert.deepEqual(await reloaded.listRulesForMint(), []);
  });

  it("publishes an empty state as 'no data', never as zeros", () => {
    const store = new JsonStateStore({ provider: "dexscreener", synthetic: false });
    const { overview, details } = buildPublicData({
      store,
      tokens: TOKENS,
      now: START,
      engine: LIVE_ENGINE,
      lifecycle: DEFAULT_LIFECYCLE,
      source: { provider: "dexscreener", name: "DexScreener", url: null, intervalMs: FIVE_MIN },
    });
    assert.equal(overview.schema, PUBLIC_SCHEMA);
    assert.equal(overview.health.status, "down");
    assert.equal(overview.health.lastCycleAt, null);
    const sol = overview.tokens[0];
    assert.ok(sol);
    for (const key of ["priceUsd", "liquidityUsd", "volume5mUsd", "score", "observedAt", "coverage"] as const) assert.equal(sol[key], null);
    assert.equal(sol.status, "no_data");
    assert.deepEqual(details.get(SOL)?.series.t, []);
  });
});

describe("synthetic preview", () => {
  it("is flagged as synthetic in every published file", async () => {
    const { data, state } = await runDemoReplay({ now: START });
    assert.equal(state.synthetic, true);
    assert.equal(data.overview.synthetic, true);
    assert.equal(data.overview.source.provider, "demo");
    assert.ok([...data.details.values()].every((d) => d.synthetic));
    assert.ok(data.overview.events.some((e) => e.status !== "resolved" && e.status !== "expired"));
    assert.ok(data.overview.generatedAt <= START && START - data.overview.generatedAt < 2 * FIVE_MIN);
  });
});
