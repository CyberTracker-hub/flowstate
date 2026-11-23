"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useNow } from "@/lib/data";
import { clockTime, duration, timeAgo } from "@/lib/format";
import { useLive } from "./live";
import { useOverview } from "./overview";

const NAV = [
  { href: "/", label: "Now" },
  { href: "/tokens/", label: "Tokens" },
  { href: "/events/", label: "Events" },
  { href: "/method/", label: "How it works" },
];

const MARK = [6, 10, 14, 18, 22];
/** Readings are due every 5 minutes; past this the page says the data is late. */
const LATE_AFTER_MS = 20 * 60_000;

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/tokens/") return pathname.startsWith("/tokens") || pathname.startsWith("/token");
  return pathname.startsWith(href.replace(/\/$/, ""));
}

function Status() {
  const { data, error, loading } = useOverview();
  const live = useLive();
  // A faster clock here so "updated 12 s ago" keeps moving.
  const now = useNow(5_000);
  if (loading) return <div className="status">Loading the latest readings…</div>;
  if (!data) {
    return (
      <div className="status">
        <strong>No data loaded</strong>
        <br />
        {error === "not_found" ? "Nothing has been published yet" : "The data files could not be reached"}
      </div>
    );
  }
  const { health } = data;
  const liveAge = live.at === null || now === null ? null : Math.max(0, Math.round((now - live.at) / 1000));
  return (
    <div className="status">
      {live.status !== "off" && (
        <>
          {liveAge !== null && liveAge <= 180 ? (
            <>
              <span className="live-mark" aria-hidden="true" />
              <strong>Prices live</strong> <span>updated {liveAge < 5 ? "just now" : `${liveAge} s ago`}</span>
            </>
          ) : live.status === "failed" ? (
            <span>Live prices are not reachable; showing the last reading</span>
          ) : (
            <span>Connecting to live prices…</span>
          )}
          <br />
        </>
      )}
      <strong>
        Scores: {health.tokensOk} of {health.tokensRequested} tokens read
      </strong>{" "}
      {now !== null && <span>{timeAgo(data.generatedAt, now)}</span>}
      <br />
      {data.source.name}, scored every {duration(data.source.intervalMs)}
      {now !== null && <span className="hide-sm"> (last at {clockTime(data.generatedAt)})</span>}
    </div>
  );
}

function Banners() {
  const { data, error, loading } = useOverview();
  const now = useNow();
  if (loading) return null;
  if (!data) {
    return (
      <div className="banner" role="status">
        {error === "outdated_site" ? (
          <>
            <strong>This page is older than the data.</strong> Reload it to get the current version.
          </>
        ) : error === "not_found" ? (
          <>
            <strong>No readings have been published yet.</strong> The collector writes its first reading within a few minutes of being switched on.
          </>
        ) : (
          <>
            <strong>The readings could not be loaded.</strong> Check your connection; this page retries every minute.
          </>
        )}
      </div>
    );
  }
  const age = now === null ? 0 : now - data.generatedAt;
  return (
    <>
      {data.synthetic && (
        <div className="banner" role="status">
          <strong>Demo data.</strong> Every figure on this page is synthetic and generated for preview. It is not market data.
        </div>
      )}
      {!data.synthetic && age > LATE_AFTER_MS && (
        <div className="banner" role="status">
          <strong>These readings are {duration(age)} old.</strong> The collector is late, so scores below describe the market as it was then.
        </div>
      )}
      {!data.synthetic && age <= LATE_AFTER_MS && data.health.status === "down" && (
        <div className="banner" role="status">
          <strong>{data.source.name} did not answer on the last attempt.</strong> Figures below are the last readings that did arrive
          {data.health.lastSuccessAt !== null && now !== null ? `, ${timeAgo(data.health.lastSuccessAt, now)}` : ""}.
        </div>
      )}
      {!data.synthetic && age <= LATE_AFTER_MS && data.health.status === "degraded" && (
        <div className="banner" role="status">
          <strong>
            {data.health.tokensFailed} of {data.health.tokensRequested} tokens could not be read
          </strong>{" "}
          on the last attempt. They show their previous reading, marked with its time.
        </div>
      )}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <div className="frame">
      <header className="masthead">
        <div className="masthead-row">
          <Link href="/" className="wordmark" aria-label="FLOWSTATE, home">
            <span className="wordmark-mark" aria-hidden="true">
              {MARK.map((h, i) => (
                <i key={h} style={{ height: h, background: `var(--stage-${i})` }} />
              ))}
            </span>
            FLOWSTATE
          </Link>
          <Status />
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <Banners />
      <main>{children}</main>
      <footer className="footer">
        <p>
          FLOWSTATE measures how unusual a token&apos;s current trading is compared with its own recent history. A score is not a
          prediction and nothing here is financial advice.
        </p>
        <p>
          Market data from{" "}
          <a href="https://dexscreener.com" target="_blank" rel="noreferrer">
            DexScreener
          </a>
          . Free to use, no account, nothing to connect.
        </p>
      </footer>
    </div>
  );
}
