"use client";

import type { PublicEvent, PublicOverview } from "@flowstate/shared";
import { FACTOR_LABELS } from "@flowstate/shared";
import Link from "next/link";
import { CONFIDENCE_LABEL, dateTime, duration, timeAgo } from "@/lib/format";
import { Gauge, Logo, SeverityTag } from "./bits";
import { FactorList } from "./factors";

function isOpen(e: PublicEvent): boolean {
  return e.status !== "resolved" && e.status !== "expired";
}

/** One anomaly: which token, how strong, what was measured, and when. */
export function EventRow({ event, overview, now, evidence = false }: { event: PublicEvent; overview: PublicOverview; now: number | null; evidence?: boolean }) {
  const token = overview.tokens.find((t) => t.mint === event.mint);
  const open = isOpen(event);
  const score = open ? event.score : event.peakScore;
  const severity = open ? event.severity : event.peakSeverity;
  const ended = event.resolvedAt ?? event.updatedAt;
  return (
    <article className="event">
      <div className="event-token">
        <Logo url={token?.logoUrl ?? null} symbol={event.symbol} />
        <div style={{ minWidth: 0 }}>
          <Link className="event-symbol" href={`/token/?mint=${event.mint}`}>
            {event.symbol}
          </Link>
          <div className="event-name">{token?.name ?? ""}</div>
        </div>
      </div>
      <div className="event-score">
        <div className="event-score-line">
          <span className="score">{score}</span>
          <SeverityTag severity={severity} />
        </div>
        <Gauge score={score} severity={severity} bands={overview.engine.bands} />
        {!open && <span className="section-note">Peak score</span>}
        {open && event.peakScore > event.score && <span className="section-note">Peaked at {event.peakScore}</span>}
      </div>
      <div className="event-summary">
        {event.summary ?? `${event.type === "composite" ? "Several signals" : FACTOR_LABELS[event.type]} above this token's usual range.`}
        {event.evidence && (
          <div className="section-note" style={{ marginTop: 6 }}>
            {Math.round(event.evidence.coverage * 100)}% of signals measurable, data confidence {CONFIDENCE_LABEL[event.evidence.confidence].toLowerCase()}
          </div>
        )}
        {evidence && event.evidence && (
          <details className="more">
            <summary>Evidence at the strongest reading</summary>
            <FactorList factors={event.evidence.factors} />
          </details>
        )}
      </div>
      <div className="event-meta">
        {open ? (
          <>
            Started {now === null ? dateTime(event.detectedAt) : timeAgo(event.detectedAt, now)}
            <br />
            <span className="muted">ongoing</span>
          </>
        ) : (
          <>
            {dateTime(event.detectedAt)}
            <br />
            <span className="muted">
              {event.status === "expired" ? "data stopped after" : "lasted"} {duration(ended - event.detectedAt)}
            </span>
          </>
        )}
      </div>
    </article>
  );
}

export { isOpen as isOpenEvent };
