"use client";

import type { FactorType } from "@flowstate/anomaly-engine";
import { FACTOR_LABELS } from "@flowstate/shared";
import { SEVERITIES, SEVERITY_LABEL } from "@/lib/format";
import { DEFAULT_BANDS, useOverview } from "../overview";

const FACTOR_TEXT: Record<FactorType, string> = {
  volume:
    "The last 5 minutes of traded volume against the token's typical 5 minutes, over both the last hour and the last day. The smaller of the two multiples counts, so one odd reading in either window cannot dominate.",
  buyer_activity: "The number of buys in the last 5 minutes against the token's typical count.",
  buy_sell_imbalance:
    "How far the split between buys and sells is from the token's usual split. Differences that could be chance for that number of trades score zero.",
  liquidity: "The change in pool liquidity against the median of the last half hour, measured on the same set of pools.",
  large_transaction: "The largest single trade relative to pool liquidity. The current data source does not report single trades, so this signal is switched off.",
  price_volume_divergence: "Volume far above normal while price barely moves, or price moving on ordinary volume.",
};

const DEFAULT_WEIGHTS: Record<FactorType, number> = {
  volume: 25,
  buyer_activity: 20,
  buy_sell_imbalance: 15,
  liquidity: 15,
  large_transaction: 15,
  price_volume_divergence: 10,
};

export function MethodPage() {
  const { data } = useOverview();
  const bands = data?.engine.bands ?? DEFAULT_BANDS;
  const weights = data?.engine.weights ?? DEFAULT_WEIGHTS;
  const threshold = data?.engine.eventThreshold ?? 50;
  const bounds = [0, bands.elevated, bands.unusual, bands.high, bands.extreme, 101];
  const factors = (Object.keys(weights) as FactorType[]).sort((a, b) => weights[b] - weights[a]);

  return (
    <>
      <h1 className="page-title">How FLOWSTATE reads the market</h1>
      <p className="lede">
        A score says how unusual a token&apos;s trading is right now compared with that same token&apos;s recent past. It is a
        measurement of the present. It is not a forecast, a rating of the token, or advice.
      </p>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">The score</h2>
          <span className="section-note">{data ? `Model ${data.engine.version}` : ""}</span>
        </div>
        <div className="prose">
          <p>
            Every five minutes each token gets a reading: price, traded volume, the number of buys and sells, and the liquidity in
            its pools. Six signals compare that reading with the token&apos;s own history. Each signal contributes up to a fixed
            number of points, and the points add up to a score from 0 to 100.
          </p>
        </div>
        <div className="bands">
          {SEVERITIES.map((severity, i) => (
            <div key={severity} className={`band stage-${i}`}>
              <div className="band-bar" />
              <div className="band-name">{SEVERITY_LABEL[severity]}</div>
              <div className="num muted">
                {bounds[i]} to {(bounds[i + 1] ?? 101) - 1}
              </div>
            </div>
          ))}
        </div>
        <div className="prose">
          <p>
            An anomaly event opens when a score reaches {threshold}. While the activity continues the same event is updated, so one
            movement is one event. It ends after the score has stayed below {threshold} for 15 minutes.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">The six signals</h2>
          <span className="section-note">Points add up to 100</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Points</th>
                <th className="left">What is compared</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((type) => (
                <tr key={type}>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{FACTOR_LABELS[type]}</td>
                  <td className="num">{weights[type]}</td>
                  <td className="left" style={{ maxWidth: "70ch" }}>
                    {FACTOR_TEXT[type]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What the page will not do</h2>
        </div>
        <div className="prose">
          <h3>Show a number it does not have</h3>
          <p>
            A missing value is shown as a dash, never as zero. A signal that cannot be measured adds neither points nor weight: the
            score is worked out over the signals that could be measured, and every score states what share of the total that was.
            Below {Math.round((data?.engine.minCoverageForScore ?? 0.4) * 100)}% there is no score at all, and below{" "}
            {Math.round((data?.engine.minCoverageForAlert ?? 0.6) * 100)}% a score cannot open an event.
          </p>
          <h3>Score a token it has just met</h3>
          <p>
            A token is scored only after {data?.engine.minHistorySamples ?? 12} readings, about an hour. Until then the page says the
            baseline is being built. The comparison is at its best after a full day of readings.
          </p>
          <h3>Pretend old data is current</h3>
          <p>
            Every figure carries the time of its reading. If the collector is late, or the data source did not answer, a notice at
            the top of the page says so and how old the readings are.
          </p>
          <h3>Tell you what to buy</h3>
          <p>
            Unusual activity has many causes: news, a single large holder, a pool being moved, bots trading with each other. The
            score cannot tell these apart and says nothing about where the price goes next.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Where the data comes from</h2>
        </div>
        <div className="prose">
          <p>
            Readings come from the public{" "}
            <a href="https://docs.dexscreener.com/api/reference" target="_blank" rel="noreferrer">
              DexScreener API
            </a>
            . DexScreener reports each trading pool separately, so for every token FLOWSTATE fixes a set of its deepest pools (up to
            five) and adds up their volume, trades and liquidity. The price is taken from the most traded of those pools. Each
            token&apos;s page lists the pools used.
          </p>
          <p>
            Known limits: activity in pools outside that set is not counted; the five-minute window is DexScreener&apos;s rolling
            window at the moment of the reading; unique wallets and single trades are not available, so buyer activity is counted
            in buys, not people. The thresholds are reasoned starting values and have not been tuned against outcomes.
          </p>
          <p>
            Two clocks run on this site. Prices, volumes, trade counts and liquidity are fetched by your browser straight from
            DexScreener and refresh every 30 seconds. Scores and events come from a collector that runs on a schedule and is
            sometimes late or skipped, so score readings are usually 5 to 15 minutes apart. Every score shows the time of its
            reading.
          </p>
        </div>
      </section>
    </>
  );
}
