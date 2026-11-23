"use client";

import type { PublicTokenDetail } from "@flowstate/shared";
import { formatCompactUsd, formatCount, formatPriceUsd, shortenAddress } from "@flowstate/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useJson, useNow } from "@/lib/data";
import { CONFIDENCE_LABEL, clockTime, timeAgo } from "@/lib/format";
import { Change, Gauge, Logo, SeverityTag } from "../bits";
import { EventRow } from "../event-row";
import { FactorList } from "../factors";
import { useLive, withLive } from "../live";
import { useOverview } from "../overview";
import { TimeCharts } from "../time-charts";

/** Solana addresses are base58, 32–44 characters. Anything else never reaches a URL. */
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function CopyMint({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(mint).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Address copied" : "Copy address"}
    </button>
  );
}

export function TokenPage() {
  const params = useSearchParams();
  const raw = params.get("mint") ?? "";
  const mint = MINT.test(raw) ? raw : null;
  const { data: overview } = useOverview();
  const { data, error, loading } = useJson<PublicTokenDetail>(mint ? `tokens/${mint}.json` : null);
  const now = useNow();
  const live = useLive();

  const back = (
    <Link href="/tokens/" className="back">
      All monitored tokens
    </Link>
  );

  if (!mint || (!loading && !data && error === "not_found")) {
    return (
      <>
        {back}
        <h1 className="page-title">This token is not monitored</h1>
        <p className="lede">
          FLOWSTATE follows a fixed list of Solana tokens with deep, active pools. Pick one from the list to see its readings.
        </p>
      </>
    );
  }
  if (!data || !overview) {
    return (
      <>
        {back}
        <p className="empty">{loading ? "Loading readings…" : "The readings for this token could not be loaded. This page retries every minute."}</p>
      </>
    );
  }

  const { detection } = data;
  // Market figures are overlaid with the live reading; the score below keeps its own reading time.
  const token = withLive(data.token, live, now);
  const isLive = token !== data.token;
  const engine = overview.engine;
  const stale = token.observedAt !== null && token.observedAt < data.generatedAt - engine.staleAfterMs;

  return (
    <>
      {back}
      <div className="token-head">
        <Logo url={token.logoUrl} symbol={token.symbol} large />
        <div>
          <h1 className="token-title">{token.symbol}</h1>
          <div className="token-sub">
            {token.name && <span>{token.name}</span>}
            <span className="num" title={token.mint}>
              {shortenAddress(token.mint, 6)}
            </span>
            <CopyMint mint={token.mint} />
            <a href={`https://dexscreener.com/solana/${token.mint}`} target="_blank" rel="noreferrer">
              DexScreener
            </a>
            <a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer">
              Solscan
            </a>
          </div>
        </div>
      </div>

      <div className="figures">
        <div className="figure">
          <div className="figure-label">
            Price
            {isLive && (
              <span className="live-tag">
                <span className="live-mark" aria-hidden="true" />
                live
              </span>
            )}
          </div>
          <div className="figure-value num">{formatPriceUsd(token.priceUsd)}</div>
          <div className="figure-note">
            {token.change.h24 === null ? "24 h change not reported" : (
              <>
                <Change value={token.change.h24} /> in 24 h
              </>
            )}
          </div>
        </div>
        <div className="figure">
          <div className="figure-label">Volume, last 5 min</div>
          <div className="figure-value num">{formatCompactUsd(token.volume5mUsd)}</div>
          <div className="figure-note num">
            {token.buys5m === null || token.sells5m === null ? "Trade counts unknown" : `${formatCount(token.buys5m)} buys, ${formatCount(token.sells5m)} sells`}
          </div>
        </div>
        <div className="figure">
          <div className="figure-label">Volume, 24 h</div>
          <div className="figure-value num">{formatCompactUsd(token.volumeH24Usd)}</div>
          <div className="figure-note num">{token.tradesH1 === null ? "" : `${formatCount(token.tradesH1)} trades in the last hour`}</div>
        </div>
        <div className="figure">
          <div className="figure-label">Liquidity in pools</div>
          <div className="figure-value num">{formatCompactUsd(token.liquidityUsd)}</div>
          <div className="figure-note">
            {token.poolCount === 0 ? "" : `across ${token.poolCount} ${token.poolCount === 1 ? "pool" : "pools"}`}
          </div>
        </div>
        <div className="figure">
          <div className="figure-label">Market cap</div>
          <div className="figure-value num">{formatCompactUsd(token.marketCapUsd)}</div>
          <div className="figure-note">{token.marketCapUsd === null ? "Not reported by the source" : "as reported by the source"}</div>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Latest reading</h2>
          <span className="section-note">
            {token.observedAt === null
              ? "No reading yet"
              : `5 minutes to ${clockTime(token.observedAt)}${now !== null ? `, ${timeAgo(token.observedAt, now)}` : ""}${stale ? " (the newest reading failed)" : ""}`}
          </span>
        </div>
        {detection === null ? (
          <p className="empty">This token has no evaluated reading yet. It appears after the collector&apos;s next successful read.</p>
        ) : (
          <div className="reading">
            <div>
              {detection.score === null || detection.severity === null ? (
                <>
                  <div className="reading-score muted">—</div>
                  <p style={{ marginTop: 12 }}>
                    Not scored yet: too few signals can be measured ({Math.round(detection.coverage * 100)}% of the total weight, {Math.round(engine.minCoverageForScore * 100)}% needed).
                    {token.samples < engine.minHistorySamples ? ` The baseline has ${token.samples} of ${engine.minHistorySamples} readings.` : ""}
                  </p>
                </>
              ) : (
                <>
                  <div>
                    <span className="reading-score">{detection.score}</span>
                    <span className="reading-scale">of 100</span>
                  </div>
                  <div style={{ margin: "14px 0 10px" }}>
                    <SeverityTag severity={detection.severity} />
                  </div>
                  <Gauge score={detection.score} severity={detection.severity} bands={engine.bands} />
                </>
              )}
              <dl className="reading-facts">
                <dt>Signals measurable</dt>
                <dd>{Math.round(detection.coverage * 100)}% of the score&apos;s weight</dd>
                <dt>Data confidence</dt>
                <dd>{CONFIDENCE_LABEL[detection.confidence.category]}</dd>
                <dt>Baseline</dt>
                <dd>{token.samples} readings</dd>
                <dt>Can open an event</dt>
                <dd>{detection.alertEligible ? "Yes" : "No, not enough of the signals are measurable"}</dd>
              </dl>
            </div>
            <FactorList factors={detection.factors} />
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Last 24 hours</h2>
          <span className="section-note">One reading every 5 minutes. Gaps are readings that did not arrive.</span>
        </div>
        <TimeCharts series={data.series} intervalMs={overview.source.intervalMs} eventThreshold={engine.eventThreshold} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Events for this token</h2>
          <span className="section-note">Last 7 days</span>
        </div>
        {data.events.length === 0 ? (
          <p className="empty">No anomaly event in the last 7 days.</p>
        ) : (
          data.events.map((event) => <EventRow key={event.id} event={event} overview={overview} now={now} evidence />)
        )}
      </section>

      {data.pools.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Pools behind these figures</h2>
            <span className="section-note">Volume, trades and liquidity are summed over these pools</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th className="left">Exchange</th>
                  <th className="left">Paired with</th>
                  <th>Liquidity</th>
                  <th>Volume, 24 h</th>
                </tr>
              </thead>
              <tbody>
                {data.pools.map((pool) => (
                  <tr key={pool.address}>
                    <td className="num">
                      {pool.url ? (
                        <a href={pool.url} target="_blank" rel="noreferrer">
                          {shortenAddress(pool.address)}
                        </a>
                      ) : (
                        shortenAddress(pool.address)
                      )}
                    </td>
                    <td className="left">
                      {pool.dexId ?? "—"}
                      {pool.labels.length > 0 && <span className="muted"> {pool.labels.join(", ")}</span>}
                    </td>
                    <td className="left">{pool.quoteSymbol ?? "—"}</td>
                    <td className="num">{formatCompactUsd(pool.liquidityUsd)}</td>
                    <td className="num">{formatCompactUsd(pool.volumeH24Usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
