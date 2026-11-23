"use client";

import { useNow } from "@/lib/data";
import { EventRow, isOpenEvent } from "../event-row";
import { useOverview } from "../overview";

export function EventsPage() {
  const { data } = useOverview();
  const now = useNow();
  const open = data?.events.filter(isOpenEvent) ?? [];
  const closed = data?.events.filter((e) => !isOpenEvent(e)) ?? [];
  return (
    <>
      <h1 className="page-title">Anomaly events</h1>
      <p className="lede">
        One event per movement: it opens when a token&apos;s score reaches the threshold, is updated while the activity continues,
        and ends after the score has stayed below the threshold for 15 minutes.
      </p>
      {data && (
        <>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Ongoing</h2>
              <span className="section-note">{open.length === 0 ? "None" : `${open.length} open`}</span>
            </div>
            {open.length === 0 ? (
              <p className="empty">No token is at or past the event threshold right now.</p>
            ) : (
              open.map((event) => <EventRow key={event.id} event={event} overview={data} now={now} evidence />)
            )}
          </section>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Ended</h2>
              <span className="section-note">Last 7 days, newest first</span>
            </div>
            {closed.length === 0 ? (
              <p className="empty">No event has ended in the last 7 days. Ended events are kept here with the evidence from their strongest reading.</p>
            ) : (
              closed.map((event) => <EventRow key={event.id} event={event} overview={data} now={now} evidence />)
            )}
          </section>
        </>
      )}
    </>
  );
}
