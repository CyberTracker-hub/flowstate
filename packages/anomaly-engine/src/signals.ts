import type { EngineConfig } from "./config";
import { flooredRatio, isFiniteNumber, linScale, logScale, median, robustZ } from "./stats";
import type {
  DetectionInput,
  FactorDetail,
  FactorResult,
  FactorType,
  Observation,
  UnavailableReason,
} from "./types";

/**
 * Signal calculators. Each one inspects the current bucket against history
 * and returns either an available factor (with an intensity in 0..1) or an
 * explicit "unavailable" result with a reason. A signal that cannot be
 * computed is never given a made-up neutral score.
 */

function nonNeg(x: number | null | undefined): x is number {
  return isFiniteNumber(x) && x >= 0;
}

function positive(x: number | null | undefined): x is number {
  return isFiniteNumber(x) && x > 0;
}

function series(history: readonly Observation[], pick: (o: Observation) => number | null): number[] {
  const out: number[] = [];
  for (const o of history) {
    const v = pick(o);
    if (nonNeg(v)) out.push(v);
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function unavailable(
  type: FactorType,
  cfg: EngineConfig,
  reason: UnavailableReason,
  detail: FactorDetail = {},
): FactorResult {
  return { type, status: "unavailable", maxPoints: cfg.weights[type], reason, detail };
}

function available(
  type: FactorType,
  cfg: EngineConfig,
  intensity: number,
  observed: number,
  baseline: number | null,
  detail: FactorDetail,
): FactorResult {
  const maxPoints = cfg.weights[type];
  const safe = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  return {
    type,
    status: "available",
    maxPoints,
    intensity: round4(safe),
    points: round4(safe * maxPoints),
    observed,
    baseline,
    detail,
  };
}

interface RatioParams {
  ratioLo: number;
  ratioHi: number;
  zLo: number;
  zHi: number;
  floor: number;
}

/**
 * Compare `cur` with a short and a long median baseline and take the more
 * conservative (smaller) ratio, so one isolated spike in either window does
 * not dominate. The robust z-score against the long window acts as a second
 * gate: a 3x move in a token whose volume routinely swings 3x scores low.
 */
function compareWithBaselines(cur: number, values: readonly number[], cfg: EngineConfig, p: RatioParams) {
  const short = values.slice(-cfg.shortWindow);
  const long = values.slice(-cfg.longWindow);
  const medShort = median(short) ?? 0;
  const medLong = median(long) ?? 0;
  const ratioShort = flooredRatio(cur, medShort, p.floor) ?? 0;
  const ratioLong = flooredRatio(cur, medLong, p.floor) ?? 0;
  const useShort = ratioShort <= ratioLong;
  const ratio = useShort ? ratioShort : ratioLong;
  const baseline = useShort ? medShort : medLong;
  const z = robustZ(cur, long) ?? 0;
  const intensity = Math.min(logScale(ratio, p.ratioLo, p.ratioHi), linScale(z, p.zLo, p.zHi));
  return { ratio, baseline, z, intensity, ratioShort, ratioLong, samples: long.length };
}

export function volumeSignal(input: DetectionInput, cfg: EngineConfig): FactorResult {
  const type: FactorType = "volume";
  const cur = input.current.volumeUsd;
  const hist = series(input.history, (o) => o.volumeUsd);
  if (!nonNeg(cur)) {
    return unavailable(type, cfg, hist.length === 0 ? "unsupported_metric" : "missing_current");
  }
  if (hist.length < cfg.minHistorySamples) {
    return unavailable(type, cfg, "insufficient_history", { samples: hist.length });
  }
  const r = compareWithBaselines(cur, hist, cfg, {
    ratioLo: cfg.volume.ratioLo,
    ratioHi: cfg.volume.ratioHi,
    zLo: cfg.volume.zLo,
    zHi: cfg.volume.zHi,
    floor: cfg.volume.minBaselineUsd,
  });
  return available(type, cfg, r.intensity, cur, r.baseline, {
    ratio: round4(r.ratio),
    ratioShortWindow: round4(r.ratioShort),
    ratioLongWindow: round4(r.ratioLong),
    robustZ: round4(r.z),
    samples: r.samples,
  });
}

export function buyerActivitySignal(input: DetectionInput, cfg: EngineConfig): FactorResult {
  const type: FactorType = "buyer_activity";
  const { current, history } = input;
  const uniqueHist = series(history, (o) => o.uniqueBuyers);
  const buyHist = series(history, (o) => o.buyCount);

  let basis: "unique_buyers" | "buy_count";
  let cur: number;
  let hist: number[];
  // Unique buyers are only used when wallet-level deduplication exists for
  // both the current bucket and the baseline. Otherwise fall back to buy counts.
  if (nonNeg(current.uniqueBuyers) && uniqueHist.length >= cfg.minHistorySamples) {
    basis = "unique_buyers";
    cur = current.uniqueBuyers;
    hist = uniqueHist;
  } else if (nonNeg(current.buyCount) && buyHist.length >= cfg.minHistorySamples) {
    basis = "buy_count";
    cur = current.buyCount;
    hist = buyHist;
  } else {
    const currentKnown = nonNeg(current.uniqueBuyers) || nonNeg(current.buyCount);
    if (currentKnown) {
      return unavailable(type, cfg, "insufficient_history", {
        samples: Math.max(uniqueHist.length, buyHist.length),
      });
    }
    const everSeen = uniqueHist.length > 0 || buyHist.length > 0;
    return unavailable(type, cfg, everSeen ? "missing_current" : "unsupported_metric");
  }

  const r = compareWithBaselines(cur, hist, cfg, {
    ratioLo: cfg.buyers.ratioLo,
    ratioHi: cfg.buyers.ratioHi,
    zLo: cfg.buyers.zLo,
    zHi: cfg.buyers.zHi,
    floor: cfg.buyers.minBaselineCount,
  });
  return available(type, cfg, r.intensity, cur, r.baseline, {
    basis,
    ratio: round4(r.ratio),
    robustZ: round4(r.z),
    samples: r.samples,
  });
}

/**
 * Buy/sell imbalance from trade COUNTS: (buys - sells) / (buys + sells).
 * Compared with the token's own pooled baseline, because many tokens are
 * structurally buy- or sell-heavy. Deviations inside the sampling-noise band
 * (2 / sqrt(n)) score zero.
 */
export function imbalanceSignal(input: DetectionInput, cfg: EngineConfig): FactorResult {
  const type: FactorType = "buy_sell_imbalance";
  const { current } = input;
  const window = input.history.slice(-cfg.longWindow);
  let histBuys = 0;
  let histSells = 0;
  let buckets = 0;
  for (const o of window) {
    if (nonNeg(o.buyCount) && nonNeg(o.sellCount)) {
      histBuys += o.buyCount;
      histSells += o.sellCount;
      buckets += 1;
    }
  }
  const buys = current.buyCount;
  const sells = current.sellCount;
  if (!nonNeg(buys) || !nonNeg(sells)) {
    return unavailable(type, cfg, buckets === 0 ? "unsupported_metric" : "missing_current");
  }
  const trades = buys + sells;
  if (trades < cfg.imbalance.minTrades) {
    return unavailable(type, cfg, "insufficient_sample", { trades, required: cfg.imbalance.minTrades });
  }
  const histTrades = histBuys + histSells;
  if (buckets < cfg.minHistorySamples || histTrades < cfg.imbalance.minBaselineTrades) {
    return unavailable(type, cfg, "insufficient_history", { samples: buckets, baselineTrades: histTrades });
  }
  const observed = (buys - sells) / trades;
  const baseline = (histBuys - histSells) / histTrades;
  const deviation = Math.abs(observed - baseline);
  const noiseBand = 2 / Math.sqrt(trades);
  const significant = deviation > noiseBand;
  const intensity = significant ? linScale(deviation, cfg.imbalance.deviationLo, cfg.imbalance.deviationHi) : 0;
  return available(type, cfg, intensity, round4(observed), round4(baseline), {
    basis: "trade_counts",
    direction: observed > baseline ? "buy_heavy" : observed < baseline ? "sell_heavy" : "balanced",
    deviation: round4(deviation),
    noiseBand: round4(noiseBand),
    significant,
    trades,
  });
}

/**
 * Liquidity change against the median of the most recent buckets reported by
 * the SAME source. If the reporting source (provider or pool) changed, the
 * move cannot be told apart from a reporting artefact, so the signal is
 * marked unavailable instead of being scored.
 */
export function liquiditySignal(input: DetectionInput, cfg: EngineConfig): FactorResult {
  const type: FactorType = "liquidity";
  const { current } = input;
  const cur = current.liquidityUsd;
  const recent = input.history.slice(-cfg.liquidity.baselineWindow).filter((o) => nonNeg(o.liquidityUsd));
  if (!nonNeg(cur)) {
    const everSeen = input.history.some((o) => nonNeg(o.liquidityUsd));
    return unavailable(type, cfg, everSeen ? "missing_current" : "unsupported_metric");
  }
  if (recent.length < cfg.liquidity.minSamples) {
    return unavailable(type, cfg, "insufficient_history", { samples: recent.length });
  }
  const source = current.liquiditySource;
  const comparable = source === null ? recent : recent.filter((o) => o.liquiditySource === source);
  if (comparable.length < cfg.liquidity.minSamples) {
    const last = recent[recent.length - 1];
    return unavailable(type, cfg, "reporting_change", {
      currentSource: source,
      previousSource: last?.liquiditySource ?? null,
    });
  }
  const baseline = median(comparable.map((o) => o.liquidityUsd as number)) ?? 0;
  if (baseline < cfg.liquidity.minBaselineUsd) {
    return unavailable(type, cfg, "baseline_too_small", { baselineUsd: baseline });
  }
  const change = (cur - baseline) / baseline;
  const intensity = linScale(Math.abs(change), cfg.liquidity.changeLo, cfg.liquidity.changeHi);
  return available(type, cfg, intensity, cur, baseline, {
    changePct: round4(change * 100),
    direction: change > 0 ? "addition" : change < 0 ? "removal" : "none",
    samples: comparable.length,
  });
}

/**
 * Largest single trade relative to pool liquidity, and (when history exists)
 * relative to the token's usual largest trade. Requires transaction-level
 * coverage; without it the signal is reported as unsupported.
 */
export function largeTransactionSignal(input: DetectionInput, cfg: EngineConfig): FactorResult {
  const type: FactorType = "large_transaction";
  const { current } = input;
  const largest = current.largestTradeUsd;
  const hist = series(input.history.slice(-cfg.longWindow), (o) => o.largestTradeUsd);
  if (!nonNeg(largest)) {
    return unavailable(type, cfg, hist.length === 0 ? "unsupported_metric" : "missing_current");
  }
  const liquidity = current.liquidityUsd;
  if (!positive(liquidity)) {
    return unavailable(type, cfg, "missing_current", { missing: "liquidity" });
  }
  const share = largest / liquidity;
  const shareIntensity = logScale(share, cfg.largeTx.shareLo, cfg.largeTx.shareHi);
  if (hist.length < cfg.minHistorySamples) {
    return available(type, cfg, shareIntensity, largest, null, {
      shareOfLiquidityPct: round4(share * 100),
      historyCompared: false,
    });
  }
  const baseline = median(hist) ?? 0;
  const ratio = flooredRatio(largest, baseline, cfg.largeTx.minBaselineUsd) ?? 0;
  const historyIntensity = logScale(ratio, cfg.largeTx.historyRatioLo, cfg.largeTx.historyRatioHi);
  return available(type, cfg, Math.min(shareIntensity, historyIntensity), largest, baseline, {
    shareOfLiquidityPct: round4(share * 100),
    ratioToTypicalLargest: round4(ratio),
    historyCompared: true,
  });
}

/**
 * Price-volume divergence: one of volume / absolute price move is far above
 * its own baseline while the other is not. This is a statistical observation
 * about the current bucket only. It says nothing about future price.
 */
export function divergenceSignal(input: DetectionInput, cfg: EngineConfig): FactorResult {
  const type: FactorType = "price_volume_divergence";
  const { current } = input;
  if (!positive(current.priceUsd) || !nonNeg(current.volumeUsd)) {
    return unavailable(type, cfg, "missing_current");
  }
  const window = input.history.slice(-(cfg.longWindow + 1));
  const absReturns: number[] = [];
  let previousPrice: number | null = null;
  for (const o of window) {
    if (positive(o.priceUsd)) {
      if (previousPrice !== null) absReturns.push(Math.abs(o.priceUsd / previousPrice - 1));
      previousPrice = o.priceUsd;
    }
  }
  const volumes = series(input.history.slice(-cfg.longWindow), (o) => o.volumeUsd);
  if (
    previousPrice === null ||
    absReturns.length < cfg.minHistorySamples ||
    volumes.length < cfg.minHistorySamples
  ) {
    return unavailable(type, cfg, "insufficient_history", {
      priceSamples: absReturns.length,
      volumeSamples: volumes.length,
    });
  }
  const signedReturn = current.priceUsd / previousPrice - 1;
  const priceZ = robustZ(Math.abs(signedReturn), absReturns) ?? 0;
  const volumeZ = robustZ(current.volumeUsd, volumes) ?? 0;
  const d = cfg.divergence;
  let pattern: "volume_without_price" | "price_without_volume" | "none" = "none";
  if (volumeZ >= d.elevatedZ && priceZ <= d.quietZ) pattern = "volume_without_price";
  else if (priceZ >= d.elevatedZ && volumeZ <= d.quietZ) pattern = "price_without_volume";
  const gap = Math.abs(volumeZ - priceZ);
  const intensity = pattern === "none" ? 0 : linScale(gap, d.gapLo, d.gapHi);
  return available(type, cfg, intensity, round4(gap), null, {
    pattern,
    priceChangePct: round4(signedReturn * 100),
    priceMoveZ: round4(priceZ),
    volumeZ: round4(volumeZ),
  });
}

export function computeFactors(input: DetectionInput, cfg: EngineConfig): FactorResult[] {
  return [
    volumeSignal(input, cfg),
    buyerActivitySignal(input, cfg),
    imbalanceSignal(input, cfg),
    liquiditySignal(input, cfg),
    largeTransactionSignal(input, cfg),
    divergenceSignal(input, cfg),
  ];
}
