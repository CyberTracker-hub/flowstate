"use client";

import { aggregatePools, createDexScreenerClient, DEXSCREENER_BATCH, type DexPool } from "@flowstate/market-data";
import type { PublicChange, PublicOverview, PublicToken } from "@flowstate/shared";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useOverview } from "./overview";

/**
 * Live market figures.
 *
 * The collector publishes a reading every five minutes or so. Between those
 * readings the visitor's own browser asks DexScreener for the same pinned
 * pools (the API allows cross-origin requests) and sums them with the SAME
 * code the collector uses, so price, volume, trades and liquidity on the
 * page are at most about half a minute old.
 *
 * Scores are NOT recalculated here: they need the collector's history and
 * stay on the five-minute rhythm, each with the time of its reading.
 * If the live request fails, the page quietly keeps the published reading.
 */

export const LIVE_REFRESH_MS = 30_000;

export interface LiveReading {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  change: PublicChange;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  tradesH1: number | null;
}

export interface LiveState {
  /** "off": nothing to refresh (demo data, or no pool list published yet). */
  status: "off" | "starting" | "live" | "failed";
  /** When the figures were last refreshed successfully. */
  at: number | null;
  readings: ReadonlyMap<string, LiveReading>;
}

const OFF: LiveState = { status: "off", at: null, readings: new Map() };
const LiveContext = createContext<LiveState>(OFF);

function metric(m: { state: string; value?: number }): number | null {
  return m.state === "ok" && typeof m.value === "number" ? m.value : null;
}

async function fetchReadings(targets: ReadonlyArray<{ mint: string; pools: string[] }>): Promise<Map<string, LiveReading>> {
  const client = createDexScreenerClient({ retry: { maxAttempts: 1 }, timeoutMs: 8_000 });
  const addresses = targets.flatMap((t) => t.pools);
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += DEXSCREENER_BATCH) batches.push(addresses.slice(i, i + DEXSCREENER_BATCH));
  const received: DexPool[] = (await Promise.all(batches.map((batch) => client.poolsByAddress(batch)))).flat();
  const now = Date.now();
  const out = new Map<string, LiveReading>();
  for (const { mint, pools } of targets) {
    const result = aggregatePools(mint, pools, received, now);
    if (!result.ok) continue;
    const m = result.snapshot.metrics;
    out.set(mint, {
      priceUsd: metric(m.priceUsd),
      marketCapUsd: metric(m.marketCapUsd),
      liquidityUsd: metric(m.liquidityUsd),
      volume5mUsd: metric(m.volumeUsd),
      buys5m: metric(m.buyCount),
      sells5m: metric(m.sellCount),
      change: result.context.priceChangePct,
      volumeH1Usd: result.context.volumeH1Usd,
      volumeH24Usd: result.context.volumeH24Usd,
      tradesH1: result.context.tradesH1,
    });
  }
  return out;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { data } = useOverview();
  const [state, setState] = useState<LiveState>(OFF);

  // The pool list only changes when pools are re-selected (every few hours),
  // so this key keeps the polling loop stable across overview refreshes.
  const key = useMemo(() => {
    if (!data || data.synthetic) return "";
    return data.tokens
      .filter((t) => (t.pools?.length ?? 0) > 0)
      .map((t) => `${t.mint}:${(t.pools ?? []).join(",")}`)
      .join("|");
  }, [data]);

  useEffect(() => {
    if (key === "") {
      setState(OFF);
      return;
    }
    const targets = key.split("|").map((entry) => {
      const [mint = "", pools = ""] = entry.split(":");
      return { mint, pools: pools.split(",") };
    });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((s) => (s.status === "live" ? s : { ...s, status: "starting" }));

    const tick = async () => {
      // No requests while the tab is in the background.
      if (document.visibilityState === "visible") {
        try {
          const readings = await fetchReadings(targets);
          if (cancelled) return;
          setState(readings.size > 0 ? { status: "live", at: Date.now(), readings } : (s) => ({ ...s, status: "failed" }));
        } catch {
          if (cancelled) return;
          // Keep the last live figures on screen; their age is shown.
          setState((s) => ({ ...s, status: "failed" }));
        }
      }
      if (!cancelled) timer = setTimeout(tick, LIVE_REFRESH_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  return useContext(LiveContext);
}

/** How old a live reading may be before the page falls back to the published one. */
const MAX_LIVE_AGE_MS = 3 * 60_000;

/**
 * Overlay live figures on a published token. A figure the live reading does
 * not know stays as published; nothing is ever replaced by a guess.
 */
export function withLive(token: PublicToken, live: LiveState, now: number | null): PublicToken {
  const reading = live.readings.get(token.mint);
  if (!reading || live.at === null || (now !== null && now - live.at > MAX_LIVE_AGE_MS)) return token;
  const pick = <T,>(fresh: T | null, published: T | null): T | null => (fresh === null ? published : fresh);
  return {
    ...token,
    priceUsd: pick(reading.priceUsd, token.priceUsd),
    marketCapUsd: pick(reading.marketCapUsd, token.marketCapUsd),
    liquidityUsd: pick(reading.liquidityUsd, token.liquidityUsd),
    volume5mUsd: pick(reading.volume5mUsd, token.volume5mUsd),
    buys5m: pick(reading.buys5m, token.buys5m),
    sells5m: pick(reading.sells5m, token.sells5m),
    change: {
      m5: pick(reading.change.m5, token.change.m5),
      h1: pick(reading.change.h1, token.change.h1),
      h6: pick(reading.change.h6, token.change.h6),
      h24: pick(reading.change.h24, token.change.h24),
    },
    volumeH1Usd: pick(reading.volumeH1Usd, token.volumeH1Usd),
    volumeH24Usd: pick(reading.volumeH24Usd, token.volumeH24Usd),
    tradesH1: pick(reading.tradesH1, token.tradesH1),
  };
}

/** The published overview with live market figures laid over every token. */
export function useLiveOverview(now: number | null): { overview: PublicOverview | null; isLive: boolean } {
  const { data } = useOverview();
  const live = useLive();
  const fresh = live.at !== null && (now === null || now - live.at <= MAX_LIVE_AGE_MS);
  const overview = useMemo(
    () => (data ? { ...data, tokens: data.tokens.map((t) => withLive(t, live, now)) } : null),
    // `now` only matters at the freshness boundary, which `fresh` captures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, live, fresh],
  );
  return { overview, isLive: fresh && live.readings.size > 0 };
}
