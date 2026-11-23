import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FactorResult } from "@flowstate/anomaly-engine";
import { FACTOR_LABELS, describeFactor, summarizeDetection } from "./explain";

function available(type: FactorResult["type"], points: number, observed: number, baseline: number | null, detail: FactorResult["detail"]): FactorResult {
  return { type, status: "available", maxPoints: 25, points, intensity: points / 25, observed, baseline, detail };
}

describe("plain-language factor descriptions", () => {
  it("describes each factor from its own numbers", () => {
    assert.equal(
      describeFactor(available("volume", 20, 100_140, 12_340, { ratio: 8.1 })),
      "5-minute volume $100.14K is 8.1x the typical $12.34K",
    );
    assert.equal(
      describeFactor(available("buyer_activity", 10, 61, 12, { basis: "buy_count", ratio: 5.08 })),
      "61 buys in 5 minutes, 5.1x the typical 12",
    );
    assert.equal(
      describeFactor(available("buyer_activity", 10, 137, 22, { basis: "unique_buyers", ratio: 6.2 })),
      "137 unique buyers in 5 minutes, 6.2x the typical 22",
    );
    assert.equal(
      describeFactor(available("buy_sell_imbalance", 9, -0.65, 0.02, { trades: 131, significant: true })),
      "65% more sells than buys across 131 trades; usual tilt +2%",
    );
    assert.equal(
      describeFactor(available("buy_sell_imbalance", 0, 0.1, -0.05, { trades: 1, significant: false })),
      "10% more buys than sells across 1 trade; usual tilt -5% (within sampling noise)",
    );
    assert.equal(
      describeFactor(available("liquidity", 12, 159_580, 398_900, { changePct: -60 })),
      "Pool liquidity $159.58K, down 60.0% vs. recent $398.90K",
    );
    assert.equal(
      describeFactor(available("price_volume_divergence", 6, 5, null, { pattern: "volume_without_price", priceChangePct: 0.04 })),
      "Volume far above normal while price barely moved (+0.04%)",
    );
    assert.equal(
      describeFactor(available("price_volume_divergence", 6, 5, null, { pattern: "price_without_volume", priceChangePct: -3.2 })),
      "Price moved -3.20% on ordinary volume",
    );
  });

  it("explains why a factor could not be measured instead of showing a number", () => {
    const base = { type: "volume", status: "unavailable", maxPoints: 25 } as const;
    assert.equal(describeFactor({ ...base, reason: "insufficient_history", detail: { samples: 4 } }), "Still building a baseline (4 readings so far)");
    assert.equal(describeFactor({ ...base, reason: "insufficient_history", detail: { samples: 1 } }), "Still building a baseline (1 reading so far)");
    assert.equal(
      describeFactor({ ...base, type: "buy_sell_imbalance", reason: "insufficient_sample", detail: { trades: 7, required: 20 } }),
      "Too few trades in this interval to judge (7 of 20 needed)",
    );
    assert.equal(describeFactor({ ...base, type: "large_transaction", reason: "unsupported_metric", detail: {} }), "Not available from the data source");
    assert.match(describeFactor({ ...base, type: "liquidity", reason: "reporting_change", detail: {} }), /Pool set changed/);
  });

  it("summarizes the two strongest contributors and nothing else", () => {
    const factors: FactorResult[] = [
      available("buyer_activity", 10, 61, 12, { basis: "buy_count", ratio: 5.08 }),
      available("liquidity", 0.4, 100, 100, { changePct: 0 }),
      available("volume", 20, 100_140, 12_340, { ratio: 8.1 }),
      { type: "large_transaction", status: "unavailable", maxPoints: 15, reason: "unsupported_metric", detail: {} },
    ];
    assert.equal(
      summarizeDetection({ factors }),
      "5-minute volume $100.14K is 8.1x the typical $12.34K. 61 buys in 5 minutes, 5.1x the typical 12.",
    );
    assert.equal(summarizeDetection({ factors: factors.slice(1, 2) }), null);
    assert.equal(summarizeDetection({ factors: [] }), null);
  });

  it("has a label for every factor", () => {
    assert.equal(Object.keys(FACTOR_LABELS).length, 6);
  });
});
