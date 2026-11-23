import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Z_CAP, clamp, finiteValues, flooredRatio, linScale, logScale, mad, median, robustZ } from "./stats";

describe("stats", () => {
  it("median handles odd, even and empty samples", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  it("median does not mutate its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    assert.deepEqual(xs, [3, 1, 2]);
  });

  it("mad is the median absolute deviation", () => {
    assert.equal(mad([1, 2, 3, 4, 100]), 1);
    assert.equal(mad([]), null);
  });

  it("finiteValues drops null, undefined, NaN and Infinity", () => {
    assert.deepEqual(finiteValues([1, null, undefined, Number.NaN, Infinity, -Infinity, 0]), [1, 0]);
  });

  it("robustZ is resistant to an outlier in the sample", () => {
    const z = robustZ(4, [1, 2, 3, 4, 100]);
    assert.ok(z !== null);
    assert.ok(Math.abs(z - 1 / 1.4826) < 1e-9);
  });

  it("robustZ never divides by zero when the sample has no dispersion", () => {
    assert.equal(robustZ(5, [5, 5, 5, 5]), 0);
    assert.equal(robustZ(6, [5, 5, 5, 5]), Z_CAP);
    assert.equal(robustZ(4, [5, 5, 5, 5]), -Z_CAP);
  });

  it("robustZ falls back to mean absolute deviation when MAD is zero", () => {
    // More than half the values are identical, so MAD = 0 but dispersion exists.
    const z = robustZ(10, [5, 5, 5, 5, 9]);
    assert.ok(z !== null && z > 0 && z < Z_CAP);
  });

  it("robustZ is clamped and returns null for unusable input", () => {
    assert.equal(robustZ(1e12, [1, 2, 3, 4, 5]), Z_CAP);
    assert.equal(robustZ(Number.NaN, [1, 2, 3]), null);
    assert.equal(robustZ(1, []), null);
  });

  it("flooredRatio guards against zero and tiny denominators", () => {
    assert.equal(flooredRatio(500, 0, 100), 5);
    assert.equal(flooredRatio(500, 250, 100), 2);
    assert.equal(flooredRatio(Number.NaN, 1, 1), null);
    assert.equal(flooredRatio(1, 1, 0), null);
  });

  it("scales are clamped to 0..1 and never return NaN", () => {
    assert.equal(linScale(5, 0, 10), 0.5);
    assert.equal(linScale(-5, 0, 10), 0);
    assert.equal(linScale(50, 0, 10), 1);
    assert.equal(linScale(Number.NaN, 0, 10), 0);
    assert.equal(logScale(1, 1.5, 8), 0);
    assert.equal(logScale(8, 1.5, 8), 1);
    assert.ok(Math.abs(logScale(Math.sqrt(1.5 * 8), 1.5, 8) - 0.5) < 1e-12);
    assert.equal(logScale(0, 1.5, 8), 0);
    assert.equal(clamp(Number.NaN, 0, 1), 0);
  });
});
