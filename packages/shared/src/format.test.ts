import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY,
  formatCompact,
  formatCompactUsd,
  formatCount,
  formatPercent,
  formatPriceUsd,
  formatRatio,
  shortenAddress,
} from "./format";

describe("financial number formatting", () => {
  it("renders unknown values as an em dash, never as zero", () => {
    for (const bad of [null, undefined, Number.NaN, Infinity, -Infinity]) {
      assert.equal(formatPriceUsd(bad), EMPTY);
      assert.equal(formatCompactUsd(bad), EMPTY);
      assert.equal(formatPercent(bad), EMPTY);
      assert.equal(formatRatio(bad), EMPTY);
      assert.equal(formatCount(bad), EMPTY);
    }
  });

  it("formats prices with magnitude-aware precision", () => {
    assert.equal(formatPriceUsd(1234.5), "$1,234.50");
    assert.equal(formatPriceUsd(1), "$1.00");
    assert.equal(formatPriceUsd(0.5), "$0.5000");
    assert.equal(formatPriceUsd(0.0123456), "$0.01235");
    assert.equal(formatPriceUsd(0.00001234), "$0.00001234");
    assert.equal(formatPriceUsd(0), "$0.00");
    assert.equal(formatPriceUsd(-2.5), "-$2.50");
  });

  it("formats compact amounts and promotes units at rounding boundaries", () => {
    assert.equal(formatCompact(12), "12");
    assert.equal(formatCompact(12.5), "12.50");
    assert.equal(formatCompact(996), "996");
    assert.equal(formatCompact(1_234), "1.23K");
    assert.equal(formatCompact(1_500_000), "1.50M");
    assert.equal(formatCompact(2_340_000_000), "2.34B");
    assert.equal(formatCompact(999_999), "1.00M");
    assert.equal(formatCompact(999.999), "1.00K");
    assert.equal(formatCompactUsd(48_200), "$48.20K");
    assert.equal(formatCompactUsd(-48_200), "-$48.20K");
  });

  it("formats signed percentages without a negative zero", () => {
    assert.equal(formatPercent(5), "+5.00%");
    assert.equal(formatPercent(-12.345), "-12.35%");
    assert.equal(formatPercent(0), "0.00%");
    assert.equal(formatPercent(-0.001), "0.00%");
    assert.equal(formatPercent(1234.5, 1), "+1,234.5%");
  });

  it("formats ratios, counts and addresses", () => {
    assert.equal(formatRatio(3.42), "3.4x");
    assert.equal(formatCount(12_345.6), "12,346");
    assert.equal(shortenAddress("So11111111111111111111111111111111111111112"), "So11…1112");
    assert.equal(shortenAddress("short"), "short");
  });
});
