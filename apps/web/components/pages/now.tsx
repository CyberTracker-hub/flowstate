"use client";

import Link from "next/link";
import { useNow } from "@/lib/data";
import { duration } from "@/lib/format";
import { EventRow, isOpenEvent } from "../event-row";
import { useLiveOverview } from "../live";
import { useOverview } from "../overview";
import { StageBoard } from "../stage-board";
import { TokenTable } from "../token-table";

export function NowPage() {
  const { data } = useOverview();
  const now = useNow();
  const open = data?.events.filter(isOpenEvent) ?? [];
  const closed = data?.events.filter((e) => !isOpenEvent(e)).slice(0, 4) ?? [];
  const scored = data?.tokens.filter((t) => t.score !== null).length ?? 0;
  const { overview: liveOverview, isLive } = useLiveOverview(now);

  return (
    <>
      <h1 className="page-title">Unusual flow on Solana, as it happens</h1>
      <p className="lede">
        Every five minutes FLOWSTATE compares each token&apos;s trading with that token&apos;s own recent history and scores how
        unusual it is, from 0 to 100. Prices and volumes on this page are live. It measures what is happening; it does not predict
        what happens next.
      </p>

      {data && <StageBoard overview={data} />}

      {data && (
        <>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Open anomalies</h2>
              <span className="section-note">
                Score {data.engine.eventThreshold} or higher, with at least {Math.round(data.engine.minCoverageForAlert * 100)}% of signals
                measurable
              </span>
            </div>
            {open.length === 0 ? (
              <p className="empty">
                {scored === 0
                  ? `Nothing to report yet. A token needs ${data.engine.minHistorySamples} readings before it can be scored, which takes about ${duration(data.engine.minHistorySamples * data.source.intervalMs)} from the first reading.`
                  : `Nothing unusual right now. All ${scored} scored tokens are trading inside their own normal range.`}
              </p>
            ) : (
              open.map((event) => <EventRow key={event.id} event={event} overview={data} now={now} />)
            )}
          </section>

          {closed.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">Recently ended</h2>
                <Link href="/events/" className="section-note">
                  All events from the last 7 days
                </Link>
              </div>
              {closed.map((event) => (
                <EventRow key={event.id} event={event} overview={data} now={now} />
              ))}
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Highest scores now</h2>
              <Link href="/tokens/" className="section-note">
                All {data.tokens.length} monitored tokens
              </Link>
            </div>
            <TokenTable overview={liveOverview ?? data} limit={8} controls={false} />
            {isLive && <p className="section-note" style={{ marginTop: 10 }}>Prices, volumes and liquidity refresh every 30 seconds. Scores are recalculated about every five minutes.</p>}
          </section>
        </>
      )}
    </>
  );
}
