import type { EngineConfig } from "./config";
import { clamp, isFiniteNumber, linScale } from "./stats";
import type { Confidence, ConfidenceResult, DetectionInput, Observation } from "./types";

function hasCoreData(o: Observation): boolean {
  return isFiniteNumber(o.volumeUsd) || isFiniteNumber(o.priceUsd);
}

/**
 * Confidence describes how much the DATA behind a score can be trusted. It is
 * a coarse category built from data-quality components, deliberately biased
 * toward the weakest component. It is not a calibrated probability and must
 * never be presented as one.
 */
export function computeConfidence(
  input: DetectionInput,
  metricCoverage: number,
  cfg: EngineConfig,
): ConfidenceResult {
  const ageMs = Math.max(0, input.now - input.current.periodEnd);
  const freshness = 1 - linScale(ageMs, 0, cfg.freshness.staleAfterMs);

  const window = input.history.slice(-cfg.longWindow);
  const usable = window.filter(hasCoreData).length;

  // Statistical precision grows roughly with sqrt(n), so does this component.
  const sampleSize = Math.sqrt(clamp(usable / cfg.longWindow, 0, 1));

  // Share of the buckets that SHOULD exist in the covered time span that
  // actually carry data. Penalises ingestion gaps.
  const oldest = window[0];
  let historicalCoverage = 0;
  if (oldest !== undefined) {
    const spanBuckets = Math.round((input.current.periodStart - oldest.periodStart) / cfg.bucketMs);
    const expected = Math.min(cfg.longWindow, Math.max(spanBuckets, 0));
    historicalCoverage = expected > 0 ? clamp(usable / expected, 0, 1) : 0;
  }

  const disagreement = input.providerPriceDisagreement;
  const providerConsistency = isFiniteNumber(disagreement)
    ? 1 - linScale(Math.abs(disagreement), cfg.confidence.disagreementLo, cfg.confidence.disagreementHi)
    : null;

  const parts = [freshness, sampleSize, historicalCoverage, clamp(metricCoverage, 0, 1)];
  if (providerConsistency !== null) parts.push(providerConsistency);
  const min = Math.min(...parts);
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  const index = Math.round((0.5 * min + 0.5 * mean) * 1e4) / 1e4;

  let category: Confidence;
  if (metricCoverage < cfg.coverage.minForScore) category = "insufficient";
  else if (index >= cfg.confidence.highThreshold) category = "high";
  else if (index >= cfg.confidence.mediumThreshold) category = "medium";
  else category = "low";

  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    category,
    index,
    components: {
      freshness: r(freshness),
      sampleSize: r(sampleSize),
      historicalCoverage: r(historicalCoverage),
      metricCoverage: r(clamp(metricCoverage, 0, 1)),
      providerConsistency: providerConsistency === null ? null : r(providerConsistency),
    },
  };
}
