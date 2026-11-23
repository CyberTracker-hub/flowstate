import { computeConfidence } from "./confidence";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { computeFactors } from "./signals";
import { clamp, isFiniteNumber } from "./stats";
import type { DetectionInput, DetectionResult, FactorType, Severity } from "./types";

export function severityForScore(score: number, cfg: EngineConfig = DEFAULT_CONFIG): Severity {
  const b = cfg.severityBands;
  if (score >= b.extreme) return "extreme";
  if (score >= b.high) return "high";
  if (score >= b.unusual) return "unusual";
  if (score >= b.elevated) return "elevated";
  return "normal";
}

/**
 * Score one token at one point in time.
 *
 * Score-normalisation policy (documented in docs/architecture.md):
 *   - Signals that cannot be computed contribute neither points nor weight.
 *   - score = round(rawPoints / availableMaxPoints * 100)
 *   - If the available signals cover less than `coverage.minForScore` of the
 *     total weight, no score is produced (status "insufficient_data").
 *   - If they cover less than `coverage.minForAlert`, a score is shown but
 *     the result can never create an event or trigger a notification.
 * The score is a measure of how unusual current activity is relative to the
 * token's own baseline. It is not a probability and not a price forecast.
 */
export function detect(input: DetectionInput, cfg: EngineConfig = DEFAULT_CONFIG): DetectionResult {
  if (typeof input.mint !== "string" || input.mint.length === 0) {
    throw new TypeError("detect: mint is required");
  }
  if (!isFiniteNumber(input.now) || !isFiniteNumber(input.current.periodStart) || !isFiniteNumber(input.current.periodEnd)) {
    throw new TypeError("detect: now and current period bounds must be finite numbers");
  }

  // Defensive: history must be strictly before the current bucket, oldest first.
  const history = input.history
    .filter((o) => isFiniteNumber(o.periodStart) && o.periodStart < input.current.periodStart)
    .sort((a, b) => a.periodStart - b.periodStart);
  const clean: DetectionInput = { ...input, history };

  const factors = computeFactors(clean, cfg);

  let rawPoints = 0;
  let availableMaxPoints = 0;
  let totalMaxPoints = 0;
  let dominantFactor: FactorType | null = null;
  let dominantPoints = 0;
  for (const f of factors) {
    totalMaxPoints += f.maxPoints;
    if (f.status !== "available") continue;
    availableMaxPoints += f.maxPoints;
    rawPoints += f.points;
    if (f.points > dominantPoints) {
      dominantPoints = f.points;
      dominantFactor = f.type;
    }
  }

  const coverage = totalMaxPoints > 0 ? availableMaxPoints / totalMaxPoints : 0;
  const scored = availableMaxPoints > 0 && coverage >= cfg.coverage.minForScore;
  const score = scored ? clamp(Math.round((rawPoints / availableMaxPoints) * 100), 0, 100) : null;
  const freshnessMs = Math.max(0, clean.now - clean.current.periodEnd);
  const confidence = computeConfidence(clean, coverage, cfg);

  const alertEligible =
    scored &&
    coverage >= cfg.coverage.minForAlert &&
    freshnessMs <= cfg.freshness.staleAfterMs &&
    confidence.category !== "insufficient";

  return {
    mint: clean.mint,
    evaluatedAt: clean.now,
    scoreVersion: cfg.version,
    status: scored ? "scored" : "insufficient_data",
    score,
    severity: score === null ? null : severityForScore(score, cfg),
    rawPoints: Math.round(rawPoints * 1e4) / 1e4,
    availableMaxPoints,
    totalMaxPoints,
    coverage: Math.round(coverage * 1e4) / 1e4,
    freshnessMs,
    alertEligible,
    dominantFactor,
    factors,
    confidence,
  };
}
