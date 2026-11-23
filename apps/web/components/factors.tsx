"use client";

import type { FactorResult } from "@flowstate/anomaly-engine";
import { FACTOR_LABELS, describeFactor } from "@flowstate/shared";

/** The evidence behind a score: each signal, its points, and what was measured. */
export function FactorList({ factors }: { factors: FactorResult[] }) {
  const ordered = [...factors].sort((a, b) => {
    const pa = a.status === "available" ? a.points : -1;
    const pb = b.status === "available" ? b.points : -1;
    return pb - pa || b.maxPoints - a.maxPoints;
  });
  return (
    <ul className="factors">
      {ordered.map((f) => {
        const on = f.status === "available";
        return (
          <li key={f.type} className={`factor${on ? "" : " off"}`}>
            <span className="factor-name">{FACTOR_LABELS[f.type]}</span>
            <span className="factor-points num">{on ? `${Math.round(f.points)} of ${f.maxPoints}` : `— of ${f.maxPoints}`}</span>
            <span className="factor-bar" aria-hidden="true">
              {on && <i style={{ width: `${(f.points / f.maxPoints) * 100}%` }} />}
            </span>
            <span className="factor-text">{describeFactor(f)}</span>
          </li>
        );
      })}
    </ul>
  );
}
