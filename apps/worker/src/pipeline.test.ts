import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LIFECYCLE } from "@flowstate/anomaly-engine";
import {
  DEMO_ANOMALY_START,
  DEMO_BUCKET_MS,
  createDemoProvider,
  type MarketDataProvider,
} from "@flowstate/market-data";
import { CircuitBreaker, ProviderError } from "@flowstate/shared";
import { runDemo } from "./demo";
import { createJsonLogger, redact } from "./logger";
import { runCycle } from "./pipeline";
import { InMemoryStore } from "./store";

const START = Date.UTC(2026, 0, 1);
const noSleep = async () => {};

function ids() {
  let n = 0;
  return () => `evt-${++n}`;
}

describe("demo pipeline, end to end", async () => {
  const result = await runDemo();
  const { store, tokens } = result;
  const mintOf = (scenario: string) => {
    const token = tokens.find((t) => t.scenario === scenario);
    assert.ok(token, `demo token for ${scenario}`);
    return token.mint;
  };
  const eventsFor = (mint: string) => [...store.events.values()].filter((e) => e.mint === mint);

  it("is flagged as synthetic everywhere", () => {
    assert.equal(result.demo, true);
    assert.ok(result.summaries.every((s) => s.synthetic && s.provider === "demo"));
    for (const list of store.snapshots.values()) assert.ok(list.every((s) => s.synthetic));
  });

  it("detects each scripted anomaly as exactly one event, at the right time", () => {
    for (const scenario of ["volume_spike", "liquidity_pull", "quiet_accumulation"]) {
      const events = eventsFor(mintOf(scenario));
      assert.equal(events.length, 1, `${scenario} should produce exactly one event`);
      const event = events[0];
      assert.ok(event);
      const detectedBucket = Math.floor((event.detectedAt - START) / DEMO_BUCKET_MS) - 1;
      assert.equal(detectedBucket, DEMO_ANOMALY_START, `${scenario} detected in the first anomalous bucket`);
      assert.ok(event.peakScore >= DEFAULT_LIFECYCLE.eventThreshold);
    }
    assert.equal(eventsFor(mintOf("volume_spike"))[0]?.anomalyType, "volume");
    assert.equal(eventsFor(mintOf("liquidity_pull"))[0]?.anomalyType, "liquidity");
  });

  it("raises no events for steady tokens", () => {
    for (const token of tokens.filter((t) => t.scenario === "steady")) {
      assert.equal(eventsFor(token.mint).length, 0);
      for (const [key, d] of store.detections) {
        if (key.startsWith(`${token.mint}|`) && d.score !== null) assert.ok(d.score < 25, `steady score ${d.score}`);
      }
    }
  });

  it("shows a score but raises no event when data coverage is too thin", () => {
    const mint = mintOf("thin_coverage");
    assert.equal(eventsFor(mint).length, 0);
    const scores = [...store.detections].filter(([k]) => k.startsWith(`${mint}|`)).map(([, d]) => d);
    assert.ok(scores.some((d) => d.score !== null && d.score >= 50), "the spike is visible in the score");
    assert.ok(scores.every((d) => !d.alertEligible), "but it is never alert-eligible");
    assert.ok(scores.every((d) => d.coverage <= 0.5));
  });

  it("raises no event for a token without enough history", () => {
    const mint = mintOf("new_listing");
    assert.equal(eventsFor(mint).length, 0);
    const first = [...store.detections].find(([k]) => k.startsWith(`${mint}|`))?.[1];
    assert.equal(first?.status, "insufficient_data");
    assert.equal(first?.score, null);
  });

  it("keeps notifications under control: one per event plus real escalations", () => {
    assert.equal(store.events.size, 3);
    assert.ok(store.notifications.length >= 3 && store.notifications.length <= 5, `got ${store.notifications.length}`);
    for (const event of store.events.values()) {
      const forEvent = store.notifications.filter((n) => n.mint === event.mint);
      const severities = forEvent.map((n) => n.severity);
      assert.equal(new Set(severities).size, severities.length, "never two notifications at the same severity");
    }
  });

  it("resolves events after activity returns to normal", () => {
    for (const event of store.events.values()) {
      assert.equal(event.status, "resolved");
      assert.ok(event.resolvedAt !== null && event.resolvedAt > event.detectedAt);
    }
    const resolved = store.transitions.filter((t) => t.transition.to === "resolved");
    assert.equal(resolved.length, 3);
  });

  it("delivers alerts only when rule conditions and entitlements allow", () => {
    const deliveries = [...store.deliveries.values()];
    assert.ok(deliveries.length > 0);
    assert.ok(
      deliveries.every((d) => d.ruleId !== "demo-rule-free-telegram"),
      "a free plan must never get Telegram deliveries",
    );
    const score = deliveries.filter((d) => d.ruleId === "demo-rule-score");
    assert.ok(score.length >= 1);
    assert.ok(score.every((d) => d.observed !== null && d.observed >= 70));
    const liquidity = deliveries.filter((d) => d.ruleId === "demo-rule-liquidity");
    assert.ok(liquidity.every((d) => d.observed !== null && Math.abs(d.observed) >= 30));
    const watchlist = deliveries.filter((d) => d.ruleId === "demo-rule-watchlist");
    assert.ok(watchlist.every((d) => d.mint === mintOf("volume_spike")), "only the high-severity token fires");
    // Per-rule cooldown: consecutive firings of one rule are >= 15 minutes apart.
    for (const group of [score, liquidity, watchlist]) {
      for (let i = 1; i < group.length; i++) {
        const gap = (group[i]?.createdAt ?? 0) - (group[i - 1]?.createdAt ?? 0);
        assert.ok(gap >= 900_000, `cooldown violated: ${gap}ms`);
      }
    }
  });

  it("is reproducible", async () => {
    const again = await runDemo();
    assert.deepEqual([...again.store.events.values()], [...store.events.values()]);
    assert.deepEqual([...again.store.deliveries.keys()], [...store.deliveries.keys()]);
  });
});

describe("pipeline robustness", () => {
  function setup(bucket: number) {
    const clock = { now: START + (bucket + 1) * DEMO_BUCKET_MS + 1_000 };
    const provider = createDemoProvider({ startMs: START, now: () => clock.now });
    const store = new InMemoryStore();
    return { clock, provider, store, mints: provider.listedMints(clock.now) };
  }

  it("re-running the same cycle creates nothing twice", async () => {
    const { provider, store, clock, mints } = setup(20);
    const deps = { provider, store, now: () => clock.now, newId: ids() };
    const first = await runCycle(mints, deps);
    const second = await runCycle(mints, deps);
    assert.equal(first.snapshotsSaved, mints.length);
    assert.equal(first.detections, mints.length);
    assert.equal(second.snapshotsSaved, 0);
    assert.equal(second.detections, 0);
    assert.equal(second.alreadyProcessed, mints.length);
    assert.equal(store.detections.size, mints.length);
  });

  it("tolerates duplicate mints in the input", async () => {
    const { provider, store, clock, mints } = setup(20);
    const summary = await runCycle([...mints, ...mints], { provider, store, now: () => clock.now, newId: ids() });
    assert.equal(summary.snapshotsSaved, mints.length);
  });

  it("one failing token does not stop the others, and no data is invented for it", async () => {
    const { provider, store, clock, mints } = setup(20);
    const broken = mints[2];
    assert.ok(broken);
    const flaky: MarketDataProvider = {
      name: provider.name,
      synthetic: true,
      fetchSnapshot: async (mint) => {
        if (mint === broken) throw new ProviderError("demo", "invalid_response", "record quarantined: invalid price");
        return provider.fetchSnapshot(mint);
      },
    };
    const summary = await runCycle(mints, { provider: flaky, store, now: () => clock.now, newId: ids() });
    assert.deepEqual(summary.failures, [{ mint: broken, kind: "invalid_response" }]);
    assert.equal(summary.snapshotsSaved, mints.length - 1);
    assert.equal(store.snapshots.has(broken), false);
    assert.ok(store.providerStatus.some((s) => s.status === "degraded" && s.errorKind === "invalid_response"));
    assert.ok(store.checkpoints.has("demo|token_overview"));
  });

  it("survives a provider that throws something unexpected", async () => {
    const { store, clock, mints } = setup(20);
    const exploding: MarketDataProvider = {
      name: "demo",
      synthetic: true,
      fetchSnapshot: async () => {
        throw new RangeError("boom");
      },
    };
    const summary = await runCycle(mints, { provider: exploding, store, now: () => clock.now, newId: ids() });
    assert.equal(summary.failures.length, mints.length);
    assert.ok(summary.failures.every((f) => f.kind === "unexpected"));
    assert.equal(store.checkpoints.size, 0, "no checkpoint when nothing succeeded");
  });

  it("retries transient failures within a cycle", async () => {
    const { provider, store, clock, mints } = setup(20);
    const attempts = new Map<string, number>();
    const flaky: MarketDataProvider = {
      name: "demo",
      synthetic: true,
      fetchSnapshot: async (mint) => {
        const n = (attempts.get(mint) ?? 0) + 1;
        attempts.set(mint, n);
        if (n === 1) throw new ProviderError("demo", "rate_limited", "HTTP 429", { status: 429, retryAfterMs: 50 });
        return provider.fetchSnapshot(mint);
      },
    };
    const summary = await runCycle(mints, {
      provider: flaky,
      store,
      now: () => clock.now,
      newId: ids(),
      retry: { maxAttempts: 3, sleep: noSleep },
    });
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.snapshotsSaved, mints.length);
    assert.ok([...attempts.values()].every((n) => n === 2));
  });

  it("opens the circuit when the provider is down and stops calling it", async () => {
    const { store, clock, mints } = setup(20);
    let calls = 0;
    const down: MarketDataProvider = {
      name: "demo",
      synthetic: true,
      fetchSnapshot: async () => {
        calls += 1;
        throw new ProviderError("demo", "server", "HTTP 503", { status: 503 });
      },
    };
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 60_000, now: () => clock.now });
    const summary = await runCycle(mints, {
      provider: down,
      store,
      now: () => clock.now,
      newId: ids(),
      breaker,
      retry: { maxAttempts: 1 },
    });
    assert.equal(calls, 3, "only the first three tokens reached the provider");
    assert.equal(summary.failures.filter((f) => f.kind === "server").length, 3);
    assert.equal(summary.failures.filter((f) => f.kind === "circuit_open").length, mints.length - 3);
    assert.equal(store.snapshots.size, 0);
  });

  it("expires an open event when its data stops arriving", async () => {
    const clock = { now: START };
    const provider = createDemoProvider({ startMs: START, now: () => clock.now });
    const store = new InMemoryStore();
    const newId = ids();
    const spike = provider.tokens.find((t) => t.scenario === "volume_spike");
    assert.ok(spike);
    const at = (bucket: number) => START + (bucket + 1) * DEMO_BUCKET_MS + 1_000;

    for (let bucket = 0; bucket <= DEMO_ANOMALY_START; bucket++) {
      clock.now = at(bucket);
      await runCycle([spike.mint], { provider, store, now: () => clock.now, newId });
    }
    const open = await store.getOpenEvent(spike.mint);
    assert.ok(open, "event is open after the spike begins");

    const down: MarketDataProvider = {
      name: "demo",
      synthetic: true,
      fetchSnapshot: async () => {
        throw new ProviderError("demo", "timeout", "request timed out");
      },
    };
    let expired = 0;
    for (let bucket = DEMO_ANOMALY_START + 1; bucket <= DEMO_ANOMALY_START + 13; bucket++) {
      clock.now = at(bucket);
      const summary = await runCycle([spike.mint], {
        provider: down,
        store,
        now: () => clock.now,
        newId,
        retry: { maxAttempts: 1 },
      });
      expired += summary.eventsExpired;
    }
    assert.equal(expired, 1);
    assert.equal(store.events.get(open.eventId)?.status, "expired");
    assert.equal(await store.getOpenEvent(spike.mint), null);
  });
});

describe("logging", () => {
  it("redacts credential-like fields at any depth but keeps ordinary ones", () => {
    const out = redact({
      apiKey: "abc",
      tokens: 8,
      mint: "So111",
      nested: { Authorization: "Bearer x", botToken: "123:abc", list: [{ stripe_secret: "sk" }] },
    }) as Record<string, unknown>;
    assert.equal(out.apiKey, "[redacted]");
    assert.equal(out.tokens, 8);
    assert.equal(out.mint, "So111");
    assert.deepEqual(out.nested, {
      Authorization: "[redacted]",
      botToken: "[redacted]",
      list: [{ stripe_secret: "[redacted]" }],
    });
  });

  it("writes one JSON object per line", () => {
    const lines: string[] = [];
    const log = createJsonLogger({ service: "worker" }, (l) => lines.push(l), () => START);
    log.warn("fetch failed", { provider: "birdeye", apiKey: "should-not-appear", error: new Error("HTTP 429") });
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? "{}");
    assert.equal(record.level, "warn");
    assert.equal(record.service, "worker");
    assert.equal(record.apiKey, "[redacted]");
    assert.deepEqual(record.error, { name: "Error", message: "HTTP 429" });
    assert.ok(!lines[0]?.includes("should-not-appear"));
  });
});
