import type { DetectionInput, Observation } from "./types";

/**
 * Deterministic builders for engine tests. Not used by production code.
 */

export const BUCKET_MS = 5 * 60 * 1000;
export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

export function obs(index: number, overrides: Partial<Observation> = {}): Observation {
  const periodStart = T0 + index * BUCKET_MS;
  // Small deterministic wobble so baselines have realistic, non-zero dispersion.
  const wobble = [0, 1, -1, 2, -2, 1, 0, -1][index % 8] ?? 0;
  return {
    periodStart,
    periodEnd: periodStart + BUCKET_MS,
    priceUsd: 1 + wobble * 0.001,
    volumeUsd: 10_000 + wobble * 400,
    liquidityUsd: 500_000 + wobble * 1_000,
    tradeCount: 60 + wobble * 2,
    buyCount: 30 + wobble,
    sellCount: 30 + wobble,
    uniqueBuyers: 20 + wobble,
    uniqueSellers: 20 + wobble,
    largestTradeUsd: 500 + wobble * 20,
    liquiditySource: "demo:pool-a",
    ...overrides,
  };
}

export function history(count: number, overrides: (index: number) => Partial<Observation> = () => ({})): Observation[] {
  const out: Observation[] = [];
  for (let i = 0; i < count; i++) out.push(obs(i, overrides(i)));
  return out;
}

export function inputAt(
  historyCount: number,
  current: Partial<Observation> = {},
  extra: Partial<DetectionInput> = {},
  historyOverrides: (index: number) => Partial<Observation> = () => ({}),
): DetectionInput {
  const cur = obs(historyCount, current);
  return {
    mint: "So11111111111111111111111111111111111111112",
    now: cur.periodEnd,
    current: cur,
    history: history(historyCount, historyOverrides),
    tokenAgeMs: null,
    providerPriceDisagreement: null,
    ...extra,
  };
}
