"use client";

import type { PublicOverview, PublicToken } from "@flowstate/shared";
import { formatCompactUsd, formatPriceUsd } from "@flowstate/shared";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CONFIDENCE_LABEL, clockTime } from "@/lib/format";
import { Change, Gauge, Logo, Spark } from "./bits";

type SortKey = "score" | "symbol" | "price" | "change" | "volume" | "volume24" | "liquidity";

const PIN_KEY = "flowstate.pinned";

function readPins(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PIN_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  } catch {
    return [];
  }
}

function sortValue(t: PublicToken, key: SortKey): number | string | null {
  switch (key) {
    case "score":
      return t.score;
    case "symbol":
      return t.symbol.toLowerCase();
    case "price":
      return t.priceUsd;
    case "change":
      return t.change.h24;
    case "volume":
      return t.volume5mUsd;
    case "volume24":
      return t.volumeH24Usd;
    case "liquidity":
      return t.liquidityUsd;
  }
}

/** Every monitored token. Unknown values sort last in both directions. */
export function TokenTable({ overview, limit, controls = true }: { overview: PublicOverview; limit?: number; controls?: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "score", dir: -1 });
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<string[]>([]);
  const [pinnedFirst, setPinnedFirst] = useState(true);

  // Pins are a per-browser convenience; the page works the same without storage.
  useEffect(() => setPins(readPins()), []);
  const toggle = (mint: string) => {
    setPins((current) => {
      const next = current.includes(mint) ? current.filter((m) => m !== mint) : [...current, mint];
      try {
        window.localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: the pin lasts for this visit only.
      }
      return next;
    });
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = overview.tokens.filter(
      (t) => q === "" || t.symbol.toLowerCase().includes(q) || (t.name ?? "").toLowerCase().includes(q) || t.mint.toLowerCase() === q,
    );
    const sorted = [...filtered].sort((a, b) => {
      if (controls && pinnedFirst) {
        const pa = pins.includes(a.mint) ? 0 : 1;
        const pb = pins.includes(b.mint) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === null && vb === null) return a.symbol.localeCompare(b.symbol);
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va === vb) return a.symbol.localeCompare(b.symbol);
      return (va < vb ? -1 : 1) * sort.dir;
    });
    return limit ? sorted.slice(0, limit) : sorted;
  }, [overview.tokens, query, sort, pins, pinnedFirst, limit, controls]);

  const head = (key: SortKey, label: string, className?: string) => (
    <th className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      {controls ? (
        <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "symbol" ? 1 : -1 }))}>
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );

  const staleBefore = overview.generatedAt - overview.engine.staleAfterMs;

  return (
    <>
      {controls && (
        <div className="toolbar">
          <label>
            <span className="sr-only">Find a token</span>
            <input className="search" type="search" placeholder="Find a token" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {pins.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={pinnedFirst} onChange={(e) => setPinnedFirst(e.target.checked)} />
              Pinned tokens first
            </label>
          )}
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {head("symbol", "Token", "left")}
              {head("price", "Price")}
              {head("change", "24 h")}
              {head("volume", "Volume, 5 min", "hide-sm")}
              {head("volume24", "Volume, 24 h", "hide-md")}
              {head("liquidity", "Liquidity", "hide-md")}
              {head("score", "Score")}
              <th className="hide-sm">Recent scores</th>
              <th className="hide-md left">Data confidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const stale = t.observedAt !== null && t.observedAt < staleBefore;
              return (
                <tr key={t.mint}>
                  <td>
                    <div className="token-cell">
                      {controls && (
                        <button
                          type="button"
                          className="pin"
                          aria-pressed={pins.includes(t.mint)}
                          aria-label={pins.includes(t.mint) ? `Unpin ${t.symbol}` : `Pin ${t.symbol} to the top`}
                          onClick={() => toggle(t.mint)}
                        >
                          {pins.includes(t.mint) ? "★" : "☆"}
                        </button>
                      )}
                      <Logo url={t.logoUrl} symbol={t.symbol} />
                      <div style={{ minWidth: 0, textAlign: "left" }}>
                        <Link href={`/token/?mint=${t.mint}`}>{t.symbol}</Link>
                        {stale && t.observedAt !== null && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            last read {clockTime(t.observedAt)}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="num">{formatPriceUsd(t.priceUsd)}</td>
                  <td>
                    <Change value={t.change.h24} />
                  </td>
                  <td className="num hide-sm">{formatCompactUsd(t.volume5mUsd)}</td>
                  <td className="num hide-md">{formatCompactUsd(t.volumeH24Usd)}</td>
                  <td className="num hide-md">{formatCompactUsd(t.liquidityUsd)}</td>
                  <td>
                    {t.score === null ? (
                      <span className="muted" style={{ fontSize: 13 }}>
                        {t.status === "no_data" ? "No reading" : `Baseline ${Math.min(t.samples, overview.engine.minHistorySamples)} of ${overview.engine.minHistorySamples}`}
                      </span>
                    ) : (
                      <div className="score-cell">
                        <span className="score">{t.score}</span>
                        <Gauge score={t.score} severity={t.severity} bands={overview.engine.bands} />
                      </div>
                    )}
                  </td>
                  <td className="hide-sm">
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <Spark values={t.spark} threshold={overview.engine.eventThreshold} />
                    </div>
                  </td>
                  <td className="hide-md left">{t.confidence === null ? <span className="muted">—</span> : CONFIDENCE_LABEL[t.confidence]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="empty">No monitored token matches “{query}”. Clear the search to see all {overview.tokens.length}.</p>}
    </>
  );
}
