import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AlertContext, type AlertRule, deliveryKey, evaluateRule, validateRule } from "./alerts";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const MINT = "MintA";

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "rule-1",
    userId: "user-1",
    scope: { kind: "token", mint: MINT },
    type: "anomaly_score",
    operator: "gte",
    threshold: 70,
    minConfidence: "medium",
    cooldownSeconds: 900,
    channel: "in_app",
    enabled: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<AlertContext> = {}): AlertContext {
  return {
    mint: MINT,
    now: NOW,
    eventId: "evt-1",
    score: 82,
    severity: "high",
    confidence: "high",
    alertEligible: true,
    volumeRatio: 4.2,
    liquidityChangePct: -32,
    priceChangePct: 6.5,
    ...overrides,
  };
}

describe("alert rule evaluation", () => {
  it("fires only when the condition is met", () => {
    assert.deepEqual(evaluateRule(rule(), ctx(), null, "pro"), { fire: true, outcome: "fired", observed: 82 });
    assert.equal(evaluateRule(rule(), ctx({ score: 69 }), null, "pro").outcome, "condition_not_met");
    assert.equal(evaluateRule(rule({ operator: "gt", threshold: 82 }), ctx(), null, "pro").fire, false);
  });

  it("supports each rule type with its own metric", () => {
    assert.equal(evaluateRule(rule({ type: "volume_ratio", threshold: 3 }), ctx(), null, "pro").fire, true);
    assert.equal(evaluateRule(rule({ type: "volume_ratio", threshold: 5 }), ctx(), null, "pro").fire, false);
    // A -32% liquidity move satisfies "moved by at least 25% in either direction".
    assert.equal(
      evaluateRule(rule({ type: "liquidity_change", operator: "abs_gte", threshold: 25 }), ctx(), null, "pro").fire,
      true,
    );
    assert.equal(
      evaluateRule(rule({ type: "liquidity_change", operator: "lte", threshold: -40 }), ctx(), null, "pro").fire,
      false,
    );
    assert.equal(evaluateRule(rule({ type: "price_change", operator: "gte", threshold: 5 }), ctx(), null, "pro").fire, true);
  });

  it("watchlist rule fires for high and extreme severity on watched tokens only", () => {
    const r = rule({ type: "watchlist_high_severity", scope: { kind: "watchlist", mints: [MINT, "MintB"] } });
    assert.equal(evaluateRule(r, ctx({ severity: "high" }), null, "pro").fire, true);
    assert.equal(evaluateRule(r, ctx({ severity: "extreme" }), null, "pro").fire, true);
    assert.equal(evaluateRule(r, ctx({ severity: "unusual" }), null, "pro").fire, false);
    assert.equal(evaluateRule(r, ctx({ mint: "MintZ" }), null, "pro").outcome, "out_of_scope");
  });

  it("does not fire when the required metric is unavailable", () => {
    const r = rule({ type: "volume_ratio", threshold: 3 });
    assert.equal(evaluateRule(r, ctx({ volumeRatio: null }), null, "pro").outcome, "metric_unavailable");
    assert.equal(evaluateRule(rule(), ctx({ score: null }), null, "pro").outcome, "metric_unavailable");
  });

  it("respects minimum confidence and data eligibility", () => {
    assert.equal(evaluateRule(rule({ minConfidence: "high" }), ctx({ confidence: "medium" }), null, "pro").outcome, "below_confidence");
    assert.equal(evaluateRule(rule({ minConfidence: "low" }), ctx({ confidence: "medium" }), null, "pro").fire, true);
    assert.equal(evaluateRule(rule(), ctx({ alertEligible: false }), null, "pro").outcome, "not_eligible");
  });

  it("enforces the per-rule cooldown", () => {
    const r = rule({ cooldownSeconds: 900 });
    assert.equal(evaluateRule(r, ctx(), NOW - 899_000, "pro").outcome, "cooldown");
    assert.equal(evaluateRule(r, ctx(), NOW - 900_000, "pro").fire, true);
  });

  it("ignores disabled rules", () => {
    assert.equal(evaluateRule(rule({ enabled: false }), ctx(), null, "pro").outcome, "disabled");
  });

  it("re-checks channel entitlements at fire time", () => {
    const telegram = rule({ channel: "telegram" });
    assert.equal(evaluateRule(telegram, ctx(), null, "free").outcome, "channel_not_allowed");
    assert.equal(evaluateRule(telegram, ctx(), null, "pro").fire, true);
    assert.equal(evaluateRule(rule({ channel: "in_app" }), ctx(), null, "free").fire, true);
  });

  it("produces a stable idempotency key for the same firing", () => {
    const a = deliveryKey(rule(), ctx());
    const b = deliveryKey(rule(), ctx());
    assert.equal(a, b);
    assert.notEqual(a, deliveryKey(rule(), ctx({ now: NOW + 1 })));
    assert.notEqual(a, deliveryKey(rule({ channel: "telegram" }), ctx()));
  });
});

describe("alert rule validation", () => {
  it("accepts a well-formed rule", () => {
    assert.deepEqual(validateRule(rule()), []);
  });

  it("rejects bad thresholds, cooldowns and scopes", () => {
    assert.ok(validateRule(rule({ threshold: 140 })).some((i) => i.field === "threshold"));
    assert.ok(validateRule(rule({ threshold: Number.NaN })).some((i) => i.field === "threshold"));
    assert.ok(validateRule(rule({ type: "volume_ratio", threshold: 0 })).some((i) => i.field === "threshold"));
    assert.ok(validateRule(rule({ cooldownSeconds: 5 })).some((i) => i.field === "cooldownSeconds"));
    assert.ok(validateRule(rule({ type: "watchlist_high_severity" })).some((i) => i.field === "scope"));
    assert.ok(validateRule(rule({ operator: "between" as never })).some((i) => i.field === "operator"));
  });
});
