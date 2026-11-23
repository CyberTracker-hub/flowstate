"use client";

import type { PublicSeries } from "@flowstate/shared";
import { formatCompactUsd, formatPriceUsd } from "@flowstate/shared";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useWidth } from "@/lib/data";
import { clockTime, dateTime } from "@/lib/format";

/**
 * Small multiples over the same time axis: score, price, volume, liquidity.
 * Each measure gets its own chart and its own axis (never two scales on one
 * chart). One crosshair is shared by all four, and the reading under it is
 * printed in each chart's header, so no value depends on hovering a line.
 * Missing readings are gaps: nothing is interpolated across them.
 */

const H = 132;
const M = { top: 10, right: 58, bottom: 22, left: 2 };

type Values = Array<number | null>;

interface ChartSpec {
  key: string;
  title: string;
  values: Values;
  kind: "line" | "columns";
  format: (v: number) => string;
  /** Fixed domain; otherwise fitted to the data. */
  domain?: [number, number];
  zeroBased?: boolean;
  threshold?: { value: number; label: string };
}

function niceTicks(min: number, max: number, count = 3): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function Chart({
  spec,
  t,
  width,
  intervalMs,
  hover,
  onHover,
}: {
  spec: ChartSpec;
  t: number[];
  width: number;
  intervalMs: number;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = H - M.top - M.bottom;
  const t0 = t[0] ?? 0;
  const t1 = t[t.length - 1] ?? 1;
  const span = Math.max(intervalMs, t1 - t0);
  const slot = plotW / (span / intervalMs + 1);
  const x = (time: number) => M.left + slot / 2 + ((time - t0) / span) * (plotW - slot);

  const known = spec.values.filter((v): v is number => v !== null);
  let lo = spec.domain?.[0] ?? (spec.zeroBased ? 0 : Math.min(...known));
  let hi = spec.domain?.[1] ?? Math.max(...known);
  if (!spec.domain) {
    if (!(hi > lo)) {
      hi = lo === 0 ? 1 : lo * 1.01;
      lo = spec.zeroBased ? 0 : lo * 0.99;
    } else if (!spec.zeroBased) {
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
    }
  }
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const ticks = spec.domain ? [lo, (lo + hi) / 2, hi] : niceTicks(lo, hi);

  // Line segments break at unknown values and at missing readings.
  const segments: string[] = [];
  const areas: string[] = [];
  if (spec.kind === "line") {
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length > 0) {
        const path = run.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
        segments.push(run.length === 1 ? `${path}h0.01` : path);
        const first = run[0];
        const last = run[run.length - 1];
        if (spec.zeroBased && first && last && run.length > 1) areas.push(`${path}L${last[0].toFixed(1)},${y(lo)}L${first[0].toFixed(1)},${y(lo)}Z`);
      }
      run = [];
    };
    spec.values.forEach((v, i) => {
      const time = t[i] ?? 0;
      const previous = t[i - 1];
      if (v === null || (previous !== undefined && time - previous > intervalMs * 2.5)) flush();
      if (v !== null) run.push([x(time), y(v)]);
    });
    flush();
  }

  const barW = Math.max(1, Math.min(24, slot - (slot > 4 ? 2 : 0.5)));
  const xTicks = useMemo(() => {
    const n = width < 520 ? 3 : 5;
    return Array.from({ length: n }, (_, i) => t0 + (span * i) / (n - 1));
  }, [t0, span, width]);

  const latestIndex = spec.values.reduce<number | null>((acc, v, i) => (v !== null ? i : acc), null);
  const shown = hover ?? latestIndex;
  const shownValue = shown === null ? null : (spec.values[shown] ?? null);
  const shownTime = shown === null ? null : (t[shown] ?? null);

  const pick = (clientX: number, box: DOMRect) => {
    const px = clientX - box.left;
    let best = 0;
    let bestD = Infinity;
    t.forEach((time, i) => {
      const d = Math.abs(x(time) - px);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    onHover(best);
  };

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">{spec.title}</span>
        <span className="chart-readout num">
          <strong>{shownValue === null ? "No reading" : spec.format(shownValue)}</strong>
          {shownTime === null ? "" : hover === null ? `latest, ${clockTime(shownTime)}` : dateTime(shownTime)}
        </span>
      </div>
      <svg height={H} onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())} onPointerLeave={() => onHover(null)} aria-hidden="true">
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={M.left} x2={M.left + plotW} y1={y(tick)} y2={y(tick)} />
            <text x={M.left + plotW + 8} y={y(tick) + 4}>
              {spec.format(tick)}
            </text>
          </g>
        ))}
        {spec.threshold && (
          <g>
            <line className="threshold" x1={M.left} x2={M.left + plotW} y1={y(spec.threshold.value)} y2={y(spec.threshold.value)} />
            <text x={M.left + 2} y={y(spec.threshold.value) - 5}>
              {spec.threshold.label}
            </text>
          </g>
        )}
        {xTicks.map((time, i) => (
          <text key={time} x={x(time)} y={H - 5} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
            {clockTime(time)}
          </text>
        ))}
        {areas.map((d) => (
          <path key={d} className="area" d={d} />
        ))}
        {segments.map((d) => (
          <path key={d} className="line" d={d} />
        ))}
        {spec.kind === "columns" &&
          spec.values.map((v, i) => {
            if (v === null || v <= 0) return null;
            const top = y(v);
            const h = Math.max(1, y(lo) - top);
            const r = Math.min(4, barW / 2, h);
            const bx = x(t[i] ?? 0) - barW / 2;
            // Rounded at the data end, square at the baseline.
            return (
              <path
                key={t[i]}
                className="col"
                opacity={hover !== null && hover !== i ? 0.55 : 1}
                d={`M${bx},${top + h}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${top + h}Z`}
              />
            );
          })}
        {hover !== null && shownTime !== null && (
          <g>
            <line className="cross" x1={x(shownTime)} x2={x(shownTime)} y1={M.top} y2={M.top + plotH} />
            {spec.kind === "line" && shownValue !== null && <circle className="dot" cx={x(shownTime)} cy={y(shownValue)} r={4.5} />}
          </g>
        )}
      </svg>
    </div>
  );
}

export function TimeCharts({ series, intervalMs, eventThreshold }: { series: PublicSeries; intervalMs: number; eventThreshold: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = series.t.length;

  const specs: ChartSpec[] = [
    {
      key: "score",
      title: "Anomaly score",
      values: series.score,
      kind: "line",
      format: (v) => String(Math.round(v)),
      domain: [0, 100],
      zeroBased: true,
      threshold: { value: eventThreshold, label: `Event threshold ${eventThreshold}` },
    },
    { key: "price", title: "Price", values: series.price, kind: "line", format: (v) => formatPriceUsd(v) },
    { key: "volume", title: "Volume per 5 minutes", values: series.volume, kind: "columns", format: (v) => formatCompactUsd(v), zeroBased: true },
    { key: "liquidity", title: "Pool liquidity", values: series.liquidity, kind: "line", format: (v) => formatCompactUsd(v) },
  ];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const from = hover ?? n - 1;
      setHover(Math.min(n - 1, Math.max(0, from + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End" || e.key === "Escape") {
      setHover(null);
    }
  };

  if (n < 2) {
    return <p className="empty">Charts appear after the second reading. Readings arrive every {Math.round(intervalMs / 60_000)} minutes.</p>;
  }

  return (
    <>
      <div
        ref={ref}
        className="charts"
        tabIndex={0}
        role="group"
        aria-label="Score, price, volume and liquidity over time. Use the left and right arrow keys to step through readings; the table below lists every value."
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {width > 0 &&
          specs.map((spec) =>
            spec.values.some((v) => v !== null) ? (
              <Chart key={spec.key} spec={spec} t={series.t} width={width - 40} intervalMs={intervalMs} hover={hover} onHover={setHover} />
            ) : (
              <div key={spec.key} className="chart">
                <div className="chart-head">
                  <span className="chart-title">{spec.title}</span>
                  <span className="chart-readout">No readings in this period</span>
                </div>
              </div>
            ),
          )}
      </div>
      <details className="more">
        <summary>Show the readings as a table</summary>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Reading</th>
                <th>Score</th>
                <th>Price</th>
                <th>Volume, 5 min</th>
                <th>Buys</th>
                <th>Sells</th>
                <th>Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {series.t
                .map((_, i) => i)
                .reverse()
                .slice(0, 72)
                .map((i) => (
                  <tr key={series.t[i]}>
                    <td className="num">{dateTime(series.t[i] ?? 0)}</td>
                    <td className="num">{series.score[i] ?? "—"}</td>
                    <td className="num">{formatPriceUsd(series.price[i])}</td>
                    <td className="num">{formatCompactUsd(series.volume[i])}</td>
                    <td className="num">{series.buys[i] ?? "—"}</td>
                    <td className="num">{series.sells[i] ?? "—"}</td>
                    <td className="num">{formatCompactUsd(series.liquidity[i])}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
