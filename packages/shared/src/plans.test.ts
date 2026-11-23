import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLANS, checkQuota, effectivePlan, feedHorizon, hasFeature, historyCutoff, isPlanId } from "./plans";

const NOW = Date.UTC(2026, 5, 1);
const DAY = 24 * 60 * 60 * 1000;

describe("plans", () => {
  it("match the published tiers", () => {
    assert.equal(PLANS.free.priceUsdMonthly, 0);
    assert.equal(PLANS.pro.priceUsdMonthly, 19);
    assert.equal(PLANS.elite.priceUsdMonthly, 49);
    assert.deepEqual(
      [PLANS.free.maxWatchlists, PLANS.pro.maxWatchlists, PLANS.elite.maxWatchlists],
      [1, 5, 20],
    );
    assert.deepEqual(
      [PLANS.free.maxWatchedTokens, PLANS.pro.maxWatchedTokens, PLANS.elite.maxWatchedTokens],
      [10, 100, 500],
    );
    assert.deepEqual([PLANS.pro.maxAlertRules, PLANS.elite.maxAlertRules], [20, 100]);
    assert.deepEqual([PLANS.pro.aiExplanationsPerMonth, PLANS.elite.aiExplanationsPerMonth], [100, 500]);
    assert.deepEqual([PLANS.pro.historyDays, PLANS.elite.historyDays], [30, 180]);
    assert.equal(PLANS.free.telegramAlerts, false);
    assert.equal(PLANS.free.liveFeed, false);
  });
});

describe("effectivePlan: billing state -> entitlements", () => {
  it("no subscription is free", () => {
    assert.deepEqual(effectivePlan(null, NOW), { plan: "free", reason: "no_subscription" });
  });

  it("active and trialing subscriptions grant their plan", () => {
    assert.equal(effectivePlan({ plan: "pro", status: "active", currentPeriodEnd: NOW + DAY }, NOW).plan, "pro");
    assert.equal(effectivePlan({ plan: "elite", status: "trialing", currentPeriodEnd: NOW + DAY }, NOW).plan, "elite");
  });

  it("past_due keeps the plan only during the grace period", () => {
    const sub = { plan: "pro", status: "past_due", currentPeriodEnd: NOW - DAY };
    assert.deepEqual(effectivePlan(sub, NOW), { plan: "pro", reason: "past_due_grace" });
    assert.deepEqual(effectivePlan(sub, NOW + 3 * DAY), { plan: "free", reason: "past_due_expired" });
    assert.equal(effectivePlan({ ...sub, currentPeriodEnd: null }, NOW).plan, "free");
  });

  it("every inactive status resolves to free", () => {
    for (const status of ["incomplete", "incomplete_expired", "canceled", "unpaid", "paused"]) {
      assert.equal(effectivePlan({ plan: "elite", status, currentPeriodEnd: NOW + DAY }, NOW).plan, "free", status);
    }
  });

  it("fails closed on unknown plans and statuses", () => {
    assert.deepEqual(effectivePlan({ plan: "enterprise", status: "active", currentPeriodEnd: null }, NOW), {
      plan: "free",
      reason: "unknown_plan",
    });
    assert.deepEqual(effectivePlan({ plan: "elite", status: "definitely_paid", currentPeriodEnd: null }, NOW), {
      plan: "free",
      reason: "unknown_status",
    });
    // A forged plan string from a client must never be accepted as a plan id.
    assert.equal(isPlanId("ELITE"), false);
    assert.equal(isPlanId({ plan: "elite" }), false);
  });
});

describe("quotas and feature gates", () => {
  it("enforces watchlist and token limits exactly at the boundary", () => {
    assert.equal(checkQuota("free", "watchlists", 0).allowed, true);
    assert.equal(checkQuota("free", "watchlists", 1).allowed, false);
    assert.equal(checkQuota("free", "watchedTokens", 9).allowed, true);
    assert.equal(checkQuota("free", "watchedTokens", 10).allowed, false);
    assert.equal(checkQuota("pro", "watchedTokens", 95, 5).allowed, true);
    assert.equal(checkQuota("pro", "watchedTokens", 95, 6).allowed, false);
    assert.deepEqual(checkQuota("elite", "alertRules", 40), { allowed: true, limit: 100, used: 40, remaining: 60 });
  });

  it("treats nonsense usage numbers safely", () => {
    assert.equal(checkQuota("free", "watchlists", Number.NaN).used, 0);
    assert.equal(checkQuota("free", "watchlists", -5).used, 0);
    assert.equal(checkQuota("free", "watchedTokens", 9, 1.2).allowed, false);
  });

  it("gates features by plan", () => {
    assert.equal(hasFeature("free", "telegramAlerts"), false);
    assert.equal(hasFeature("pro", "telegramAlerts"), true);
    assert.equal(hasFeature("pro", "advancedIntelligenceFilters"), false);
    assert.equal(hasFeature("elite", "advancedIntelligenceFilters"), true);
  });

  it("computes history and feed horizons", () => {
    assert.equal(historyCutoff("pro", NOW), NOW - 30 * DAY);
    assert.equal(feedHorizon("pro", NOW), NOW);
    assert.ok(feedHorizon("free", NOW) < NOW);
  });
});
