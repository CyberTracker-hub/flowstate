import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, validateConfig, type EngineConfig } from "./config";
import { detect, severityForScore } from "./scoring";
import { volumeSignal } from "./signals";
import { BUCKET_MS, inputAt } from "./testing";
import type { AvailableFactor, DetectionResult, FactorResult, FactorType } from "./types";

function factor(result: DetectionResult, type: FactorType): FactorResult {
  const f = result.factors.find((x) => x.type === type);
  assert.ok(f, `factor ${type} missing`);
  return f;
}

function availableFactor(result: DetectionResult, type: FactorType): AvailableFactor {
  const f = factor(result, type);
  assert.equal(f.status, "available", `${type} should be available`);
  return f as AvailableFactor;
}

function assertNoNaN(value: unknown, path = "result"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

describe("config", () => {
  it("default config is valid and weights sum to 100", () => {
    validateConfig(DEFAULT_CONFIG);
    const total = Object.values(DEFAULT_CONFIG.weights).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });

  it("rejects weights that do not sum to 100", () => {
    const bad: EngineConfig = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights, volume: 30 } };
    assert.throws(() => validateConfig(bad), /sum to 100/);
  });

  it("score bands match the product definition", () => {
    const expected: Array<[number, string]> = [
      [0, "normal"],
      [24, "normal"],
      [25, "elevated"],
      [49, "elevated"],
      [50, "unusual"],
      [69, "unusual"],
      [70, "high"],
      [84, "high"],
      [85, "extreme"],
      [100, "extreme"],
    ];
    for (const [score, band] of expected) assert.equal(severityForScore(score), band, `score ${score}`);
  });
});

describe("detect: known inputs", () => {
  it("ordinary activity scores as normal with full coverage", () => {
    const result = detect(inputAt(288));
    assert.equal(result.status, "scored");
    assert.equal(result.coverage, 1);
    assert.equal(result.severity, "normal");
    assert.ok(result.score !== null && result.score < 25, `score was ${result.score}`);
    assertNoNaN(result);
  });

  it("volume at exactly the upper ratio bound earns the full 25 points", () => {
    // Flat baseline of 1,000 => zero dispersion => z gate saturates; ratio 8x => intensity 1.
    const input = inputAt(288, { volumeUsd: 8_000 }, {}, () => ({ volumeUsd: 1_000 }));
    const f = volumeSignal(input, DEFAULT_CONFIG);
    assert.equal(f.status, "available");
    assert.equal((f as AvailableFactor).points, 25);
    assert.equal((f as AvailableFactor).detail.ratio, 8);
  });

  it("volume at the log-midpoint of the ratio range earns half the points", () => {
    const mid = 1_000 * Math.sqrt(1.5 * 8);
    const input = inputAt(288, { volumeUsd: mid }, {}, () => ({ volumeUsd: 1_000 }));
    const f = volumeSignal(input, DEFAULT_CONFIG) as AvailableFactor;
    assert.equal(f.points, 12.5);
  });

  it("volume below the lower ratio bound earns nothing", () => {
    const input = inputAt(288, { volumeUsd: 1_400 }, {}, () => ({ volumeUsd: 1_000 }));
    assert.equal((volumeSignal(input, DEFAULT_CONFIG) as AvailableFactor).points, 0);
  });

  it("a broad, strong anomaly reaches the high or extreme band", () => {
    const result = detect(
      inputAt(288, {
        volumeUsd: 120_000,
        buyCount: 260,
        sellCount: 30,
        tradeCount: 290,
        uniqueBuyers: 170,
        liquidityUsd: 290_000,
        largestTradeUsd: 30_000,
      }),
    );
    assert.equal(result.status, "scored");
    assert.ok(result.score !== null && result.score >= 70, `score was ${result.score}`);
    assert.ok(result.severity === "high" || result.severity === "extreme");
    assert.equal(result.alertEligible, true);
    assert.equal(availableFactor(result, "volume").points, 25);
    assert.equal(availableFactor(result, "buyer_activity").detail.basis, "unique_buyers");
    assert.equal(availableFactor(result, "buy_sell_imbalance").detail.direction, "buy_heavy");
    assert.equal(availableFactor(result, "liquidity").detail.direction, "removal");
    assertNoNaN(result);
  });

  it("is deterministic", () => {
    const a = detect(inputAt(288, { volumeUsd: 55_000, buyCount: 120 }));
    const b = detect(inputAt(288, { volumeUsd: 55_000, buyCount: 120 }));
    assert.deepEqual(a, b);
  });

  it("the more conservative of the short and long baselines is used", () => {
    // The last hour already runs at 5x the long baseline. A further bucket at
    // that level is 5x the 24h median but ~1x the 1h median => no volume points.
    const input = inputAt(288, { volumeUsd: 50_000 }, {}, (i) => (i >= 276 ? { volumeUsd: 50_000 } : {}));
    const f = volumeSignal(input, DEFAULT_CONFIG) as AvailableFactor;
    assert.equal(f.points, 0);
    assert.ok((f.detail.ratioLongWindow as number) > 4);
    assert.ok((f.detail.ratioShortWindow as number) < 1.5);
  });

  it("detects volume without price movement as a divergence, not a forecast", () => {
    const result = detect(inputAt(288, { volumeUsd: 90_000, priceUsd: 1 }));
    const f = availableFactor(result, "price_volume_divergence");
    assert.equal(f.detail.pattern, "volume_without_price");
    assert.ok(f.points > 0);
  });

  it("detects price movement without volume", () => {
    const result = detect(inputAt(288, { priceUsd: 1.08 }));
    const f = availableFactor(result, "price_volume_divergence");
    assert.equal(f.detail.pattern, "price_without_volume");
    assert.ok(f.points > 0);
  });
});

describe("detect: missing and bad data is handled honestly", () => {
  it("distinguishes a missing value from a true zero", () => {
    const missing = factor(detect(inputAt(288, { volumeUsd: null })), "volume");
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.status === "unavailable" && missing.reason, "missing_current");

    const zero = availableFactor(detect(inputAt(288, { volumeUsd: 0 })), "volume");
    assert.equal(zero.points, 0);
    assert.equal(zero.observed, 0);
  });

  it("reports unsupported metrics instead of scoring them as neutral", () => {
    const strip = () => ({ uniqueBuyers: null, uniqueSellers: null, largestTradeUsd: null });
    const result = detect(inputAt(288, strip(), {}, strip));
    const large = factor(result, "large_transaction");
    assert.equal(large.status === "unavailable" && large.reason, "unsupported_metric");
    // Buyer activity falls back to buy counts and says so.
    assert.equal(availableFactor(result, "buyer_activity").detail.basis, "buy_count");
    assert.equal(result.availableMaxPoints, 85);
    assert.equal(result.coverage, 0.85);
    assert.equal(result.alertEligible, true);
  });

  it("normalises the score over available weight only", () => {
    const strip = () => ({ uniqueBuyers: null, uniqueSellers: null, largestTradeUsd: null });
    const result = detect(inputAt(288, { ...strip(), volumeUsd: 1_000_000 }, {}, strip));
    assert.ok(result.score !== null);
    assert.equal(result.score, Math.round((result.rawPoints / 85) * 100));
  });

  it("shows a score but never alerts when coverage is between the two thresholds", () => {
    const strip = () => ({
      buyCount: null,
      sellCount: null,
      tradeCount: null,
      uniqueBuyers: null,
      uniqueSellers: null,
      largestTradeUsd: null,
    });
    const result = detect(inputAt(288, { ...strip(), volumeUsd: 500_000 }, {}, strip));
    assert.equal(result.coverage, 0.5); // volume 25 + liquidity 15 + divergence 10
    assert.equal(result.status, "scored");
    assert.ok(result.score !== null && result.score > 0);
    assert.equal(result.alertEligible, false);
  });

  it("produces no score at all below the minimum coverage", () => {
    const strip = () => ({
      liquidityUsd: null,
      buyCount: null,
      sellCount: null,
      tradeCount: null,
      uniqueBuyers: null,
      uniqueSellers: null,
      largestTradeUsd: null,
    });
    const result = detect(inputAt(288, { ...strip(), volumeUsd: 500_000 }, {}, strip));
    assert.equal(result.coverage, 0.35);
    assert.equal(result.status, "insufficient_data");
    assert.equal(result.score, null);
    assert.equal(result.severity, null);
    assert.equal(result.alertEligible, false);
    assert.equal(result.confidence.category, "insufficient");
  });

  it("requires enough history before trusting a baseline", () => {
    const result = detect(inputAt(5, { volumeUsd: 500_000 }));
    const v = factor(result, "volume");
    assert.equal(v.status === "unavailable" && v.reason, "insufficient_history");
    assert.equal(result.alertEligible, false);
  });

  it("treats NaN and Infinity as missing and never emits NaN", () => {
    const result = detect(
      inputAt(288, { volumeUsd: Number.POSITIVE_INFINITY, priceUsd: Number.NaN, liquidityUsd: -5 }),
    );
    assertNoNaN(result);
    assert.equal(factor(result, "volume").status, "unavailable");
    assert.equal(factor(result, "liquidity").status, "unavailable");
    assert.equal(factor(result, "price_volume_divergence").status, "unavailable");
  });

  it("survives an all-zero history without dividing by zero", () => {
    const zeros = () => ({ volumeUsd: 0, buyCount: 0, sellCount: 0, tradeCount: 0, uniqueBuyers: 0, largestTradeUsd: 0 });
    const result = detect(inputAt(288, { volumeUsd: 50 }, {}, zeros));
    assertNoNaN(result);
    // $50 against a $0 baseline is below the $100 baseline floor => ratio 0.5 => no points.
    assert.equal(availableFactor(result, "volume").points, 0);
  });

  it("does not score a liquidity jump caused by a change of reporting source", () => {
    const result = detect(inputAt(288, { liquidityUsd: 900_000, liquiditySource: "demo:pool-b" }));
    const f = factor(result, "liquidity");
    assert.equal(f.status === "unavailable" && f.reason, "reporting_change");
  });

  it("scores liquidity additions and removals from the same source", () => {
    const flat = () => ({ liquidityUsd: 500_000 });
    const add = availableFactor(detect(inputAt(288, { liquidityUsd: 650_000 }, {}, flat)), "liquidity");
    assert.equal(add.detail.direction, "addition");
    assert.equal(add.baseline, 500_000);
    assert.equal(add.points, 7.5); // +30% is the midpoint of the 10%..50% range
    const remove = availableFactor(detect(inputAt(288, { liquidityUsd: 250_000 }, {}, flat)), "liquidity");
    assert.equal(remove.detail.direction, "removal");
    assert.equal(remove.points, 15);
  });

  it("ignores buy/sell imbalance that is within sampling noise", () => {
    // 14 vs 6 looks lopsided, but with only 20 trades it is inside the noise band.
    const result = detect(inputAt(288, { buyCount: 14, sellCount: 6, tradeCount: 20 }));
    const f = availableFactor(result, "buy_sell_imbalance");
    assert.equal(f.detail.significant, false);
    assert.equal(f.points, 0);
  });

  it("refuses to compute imbalance from too few trades", () => {
    const f = factor(detect(inputAt(288, { buyCount: 9, sellCount: 1, tradeCount: 10 })), "buy_sell_imbalance");
    assert.equal(f.status === "unavailable" && f.reason, "insufficient_sample");
  });

  it("stale data cannot alert and lowers confidence", () => {
    const fresh = inputAt(288, { volumeUsd: 120_000, buyCount: 260, uniqueBuyers: 170, largestTradeUsd: 30_000 });
    const stale = { ...fresh, now: fresh.now + 4 * BUCKET_MS };
    const a = detect(fresh);
    const b = detect(stale);
    assert.equal(a.alertEligible, true);
    assert.equal(b.alertEligible, false);
    assert.equal(b.confidence.components.freshness, 0);
    assert.ok(b.confidence.index < a.confidence.index);
  });

  it("ignores history that is not strictly before the current bucket", () => {
    const input = inputAt(288);
    const polluted = { ...input, history: [...input.history, { ...input.current, volumeUsd: 9e9 }] };
    assert.deepEqual(detect(polluted), detect(input));
  });

  it("rejects structurally invalid input loudly", () => {
    assert.throws(() => detect({ ...inputAt(288), mint: "" }), TypeError);
    assert.throws(() => detect({ ...inputAt(288), now: Number.NaN }), TypeError);
  });
});

describe("confidence", () => {
  it("is high with a full, fresh, gap-free day of history", () => {
    const result = detect(inputAt(288));
    assert.equal(result.confidence.category, "high");
    assert.equal(result.confidence.components.providerConsistency, null);
  });

  it("is lower for a token with little history", () => {
    const full = detect(inputAt(288));
    const young = detect(inputAt(24));
    assert.ok(young.confidence.index < full.confidence.index);
    assert.notEqual(young.confidence.category, "high");
  });

  it("is lower when history has gaps", () => {
    const gappy = detect(inputAt(288, {}, {}, (i) => (i % 2 === 0 ? { volumeUsd: null, priceUsd: null } : {})));
    assert.ok(gappy.confidence.components.historicalCoverage < 0.6);
    assert.notEqual(gappy.confidence.category, "high");
  });

  it("is lower when providers disagree on price", () => {
    const agree = detect(inputAt(288, {}, { providerPriceDisagreement: 0.001 }));
    const disagree = detect(inputAt(288, {}, { providerPriceDisagreement: 0.2 }));
    assert.equal(agree.confidence.components.providerConsistency, 1);
    assert.equal(disagree.confidence.components.providerConsistency, 0);
    assert.ok(disagree.confidence.index < agree.confidence.index);
  });
});
