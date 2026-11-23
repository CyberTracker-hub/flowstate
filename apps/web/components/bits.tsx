"use client";

import type { Severity } from "@flowstate/anomaly-engine";
import { formatPercent } from "@flowstate/shared";
import { useState } from "react";
import { SEVERITIES, SEVERITY_LABEL } from "@/lib/format";
import { DEFAULT_BANDS } from "./overview";

export function stageClass(severity: Severity | null): string {
  return `stage-${severity === null ? 0 : SEVERITIES.indexOf(severity)}`;
}

const KEY_HEIGHTS = [4, 6, 8, 10, 12];

/** Band name with a five-step key. The key's height carries the band, not only its colour. */
export function SeverityTag({ severity }: { severity: Severity }) {
  const level = SEVERITIES.indexOf(severity);
  return (
    <span className={`sev ${stageClass(severity)}`}>
      <span className="sev-key" aria-hidden="true">
        {KEY_HEIGHTS.map((h, i) => (
          <i key={h} className={i <= level ? "on" : undefined} style={{ height: h }} />
        ))}
      </span>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

/** 0–100 gauge with the band boundaries marked. */
export function Gauge({
  score,
  severity,
  bands = DEFAULT_BANDS,
}: {
  score: number | null;
  severity: Severity | null;
  bands?: { elevated: number; unusual: number; high: number; extreme: number };
}) {
  const label = score === null ? "No score" : `Score ${score} of 100${severity ? `, ${SEVERITY_LABEL[severity].toLowerCase()}` : ""}`;
  return (
    <div className={`gauge ${stageClass(severity)}`} role="img" aria-label={label}>
      {score !== null && <div className="gauge-fill" style={{ width: `${score}%` }} />}
      {[bands.elevated, bands.unusual, bands.high, bands.extreme].map((b) => (
        <span key={b} className="gauge-tick" style={{ left: `${b}%` }} />
      ))}
    </div>
  );
}

/** Token logo from the data source, or the first letters when there is none. */
export function Logo({ url, symbol, large = false }: { url: string | null; symbol: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`logo${large ? " lg" : ""}`} aria-hidden="true">
      {url && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

/** Signed percentage with a direction mark. Text stays in ink; the mark carries direction. */
export function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="num muted">—</span>;
  return (
    <span className="num">
      {value !== 0 && <span className={`dir ${value > 0 ? "up" : "down"}`} aria-hidden="true" />}
      {formatPercent(value)}
    </span>
  );
}

/** Recent scores on a fixed 0–100 scale, with the event threshold as a hairline. */
export function Spark({ values, threshold = 50, width = 96, height = 26 }: { values: Array<number | null>; threshold?: number; width?: number; height?: number }) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return <span className="muted" style={{ fontSize: 13 }}>—</span>;
  const pad = 2;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - v / 100) * (height - pad * 2);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const last = known[known.length - 1] ?? 0;
  return (
    <svg className="spark" width={width} height={height} role="img" aria-label={`Recent scores, latest ${last}, highest ${Math.max(...known)}`}>
      <line x1={0} x2={width} y1={y(threshold)} y2={y(threshold)} />
      <path d={d} />
    </svg>
  );
}
