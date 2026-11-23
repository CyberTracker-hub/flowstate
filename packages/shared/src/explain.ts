import type { DetectionResult, FactorResult, FactorType, UnavailableReason } from "@flowstate/anomaly-engine";
import { formatCompactUsd, formatCount, formatPercent, formatRatio } from "./format";

/**
 * Deterministic, plain-language descriptions of what the engine measured.
 * No AI and no interpretation beyond the numbers: every sentence is built
 * from the factor's own evidence. Nothing here predicts price.
 */

export const FACTOR_LABELS: Record<FactorType, string> = {
  volume: "Volume",
  buyer_activity: "Buyer activity",
  buy_sell_imbalance: "Buy/sell imbalance",
  liquidity: "Liquidity",
  large_transaction: "Large transactions",
  price_volume_divergence: "Price–volume divergence",
};

const REASON_TEXT: Record<UnavailableReason, string> = {
  missing_current: "No current value from the data source",
  insufficient_history: "Still building a baseline",
  insufficient_sample: "Too few trades in this interval to judge",
  unsupported_metric: "Not available from the data source",
  baseline_too_small: "Baseline too small to compare against",
  reporting_change: "Pool set changed; waiting for comparable readings",
};

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** One sentence describing a factor's reading. */
export function describeFactor(f: FactorResult): string {
  if (f.status === "unavailable") {
    const base = REASON_TEXT[f.reason];
    if (f.reason === "insufficient_history") {
      const samples = num(f.detail.samples) ?? num(f.detail.volumeSamples);
      return samples === null ? base : `${base} (${plural(samples, "reading")} so far)`;
    }
    if (f.reason === "insufficient_sample") {
      const trades = num(f.detail.trades);
      const required = num(f.detail.required);
      return trades === null || required === null ? base : `${base} (${formatCount(trades)} of ${formatCount(required)} needed)`;
    }
    return base;
  }

  const d = f.detail;
  switch (f.type) {
    case "volume": {
      const ratio = num(d.ratio);
      return `5-minute volume ${formatCompactUsd(f.observed)} is ${formatRatio(ratio)} the typical ${formatCompactUsd(f.baseline)}`;
    }
    case "buyer_activity": {
      const unit = d.basis === "unique_buyers" ? "unique buyers" : "buys";
      return `${formatCount(f.observed)} ${unit} in 5 minutes, ${formatRatio(num(d.ratio))} the typical ${formatCount(f.baseline)}`;
    }
    case "buy_sell_imbalance": {
      const side = f.observed > 0 ? "buys" : f.observed < 0 ? "sells" : null;
      const now = side === null ? "Buys and sells are balanced" : `${formatPercent(Math.abs(f.observed) * 100, 0).replace("+", "")} more ${side} than ${side === "buys" ? "sells" : "buys"}`;
      const usual = f.baseline === null ? "" : `; usual tilt ${formatPercent(f.baseline * 100, 0)}`;
      const noise = d.significant === false ? " (within sampling noise)" : "";
      return `${now} across ${plural(num(d.trades) ?? 0, "trade")}${usual}${noise}`;
    }
    case "liquidity": {
      const change = num(d.changePct);
      const verb = change === null || change === 0 ? "unchanged" : change > 0 ? "up" : "down";
      const amount = change === null || change === 0 ? "" : ` ${formatPercent(Math.abs(change), 1).replace("+", "")}`;
      return `Pool liquidity ${formatCompactUsd(f.observed)}, ${verb}${amount} vs. recent ${formatCompactUsd(f.baseline)}`;
    }
    case "large_transaction": {
      const share = num(d.shareOfLiquidityPct);
      return `Largest trade ${formatCompactUsd(f.observed)}${share === null ? "" : `, ${formatPercent(share, 2).replace("+", "")} of pool liquidity`}`;
    }
    case "price_volume_divergence": {
      const price = formatPercent(num(d.priceChangePct), 2);
      if (d.pattern === "volume_without_price") return `Volume far above normal while price barely moved (${price})`;
      if (d.pattern === "price_without_volume") return `Price moved ${price} on ordinary volume`;
      return `Price (${price}) and volume are moving together`;
    }
  }
}

/**
 * Short headline for an anomaly: the strongest contributing factors, in
 * order. Returns null when nothing contributed.
 */
export function summarizeDetection(d: Pick<DetectionResult, "factors">): string | null {
  const contributing = d.factors
    .filter((f): f is Extract<FactorResult, { status: "available" }> => f.status === "available" && f.points >= 1)
    .sort((a, b) => b.points - a.points)
    .slice(0, 2);
  if (contributing.length === 0) return null;
  return contributing.map((f) => describeFactor(f)).join(". ") + ".";
}
