"use client";

import type { PublicOverview, PublicToken } from "@flowstate/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useWidth } from "@/lib/data";
import { SEVERITIES, SEVERITY_LABEL } from "@/lib/format";

/**
 * The gauge board: every scored token as one dot on the 0–100 scale, with
 * the five bands marked underneath. Where the dots sit IS the state of the
 * market: a pile on the left is a quiet market, anything to the right of
 * the event threshold is an open anomaly.
 */

const DOT = 11; // dot pitch in px (radius 4.5 + ring)
const R = 4.5;
const MAX_STACK = 12;
const PAD = 10;

interface Placed {
  token: PublicToken;
  score: number;
  x: number;
  level: number;
}

export function StageBoard({ overview }: { overview: PublicOverview }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<Placed | null>(null);
  const bands = overview.engine.bands;
  const bounds = [0, bands.elevated, bands.unusual, bands.high, bands.extreme, 100];

  const scored = useMemo(
    () => overview.tokens.filter((t): t is PublicToken & { score: number } => t.score !== null),
    [overview.tokens],
  );
  const waiting = overview.tokens.length - scored.length;
  const plotW = Math.max(0, width - PAD * 2);
  const xOf = (score: number) => PAD + (score / 100) * plotW;

  const { placed, overflow, tallest } = useMemo(() => {
    const stacks = new Map<number, number>();
    const out: Placed[] = [];
    const spill = new Map<number, number>();
    // Strongest first, so the dots that matter are never the ones folded away.
    for (const token of [...scored].sort((a, b) => b.score - a.score)) {
      const bin = Math.round(((token.score / 100) * plotW) / DOT);
      const level = stacks.get(bin) ?? 0;
      stacks.set(bin, level + 1);
      if (level >= MAX_STACK) {
        spill.set(bin, (spill.get(bin) ?? 0) + 1);
        continue;
      }
      out.push({ token, score: token.score, x: PAD + bin * DOT, level });
    }
    return { placed: out, overflow: spill, tallest: Math.min(MAX_STACK, Math.max(0, ...stacks.values())) };
  }, [scored, plotW]);

  const top = 26; // room for labels above the tallest stack
  const baseY = top + Math.max(4, tallest) * DOT + 6;
  const height = baseY + 46;
  const yOf = (level: number) => baseY - R - 2 - level * DOT;

  // Name the tokens above the normal band, strongest first, skipping any label that would collide.
  const labels: Array<{ p: Placed; y: number }> = [];
  for (const p of placed) {
    if (p.level !== 0 || p.score < bands.elevated || labels.length >= 8) continue;
    const stackTop = baseY - R - 2 - ((placed.filter((q) => q.x === p.x).length - 1) * DOT) - 12;
    if (labels.some((l) => Math.abs(l.p.x - p.x) < Math.max(38, p.token.symbol.length * 8) && Math.abs(l.y - stackTop) < 14)) continue;
    labels.push({ p, y: stackTop });
  }

  const nearest = (clientX: number, clientY: number, box: DOMRect): Placed | null => {
    const px = clientX - box.left;
    const py = clientY - box.top;
    let best: Placed | null = null;
    let bestD = 24 * 24;
    for (const p of placed) {
      const d = (p.x - px) ** 2 + (yOf(p.level) - py) ** 2;
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  const open = overview.events.filter((e) => e.status !== "resolved" && e.status !== "expired").length;

  return (
    <section className="board" aria-label="All scored tokens on the 0 to 100 scale">
      <div className="board-head">
        <h2 className="board-title">
          {scored.length === 0
            ? "No scores yet"
            : open === 0
              ? `No open anomalies among ${scored.length} scored tokens`
              : `${open} open ${open === 1 ? "anomaly" : "anomalies"} among ${scored.length} scored tokens`}
        </h2>
        <span className="section-note">One dot per token. Further right means more unusual.</span>
      </div>
      <div ref={ref} style={{ position: "relative" }}>
        {width > 0 && (
          <svg
            height={height}
            role="group"
            onPointerMove={(e) => setActive(nearest(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()))}
            onPointerLeave={() => setActive(null)}
          >
            <line x1={xOf(overview.engine.eventThreshold)} x2={xOf(overview.engine.eventThreshold)} y1={8} y2={baseY + 6} stroke="var(--ink-3)" strokeWidth={1} />
            <text x={xOf(overview.engine.eventThreshold) + 6} y={14}>
              Event threshold {overview.engine.eventThreshold}
            </text>

            {SEVERITIES.map((severity, i) => {
              const x0 = xOf(bounds[i] ?? 0);
              const x1 = xOf(bounds[i + 1] ?? 100);
              return (
                <g key={severity}>
                  <rect x={x0 + (i === 0 ? 0 : 1)} y={baseY + 6} width={Math.max(0, x1 - x0 - (i === 4 ? 0 : 1) - (i === 0 ? 0 : 1))} height={6} rx={1} fill={`var(--stage-${i})`} />
                  <text x={x0 + (i === 0 ? 0 : 1)} y={baseY + 28} style={{ fontWeight: 600 }}>
                    {x1 - x0 > 56 ? SEVERITY_LABEL[severity] : SEVERITY_LABEL[severity].slice(0, 4)}
                  </text>
                  <text x={x0 + (i === 0 ? 0 : 1)} y={baseY + 42}>
                    {bounds[i]}
                    {i === 4 ? "–100" : ""}
                  </text>
                </g>
              );
            })}

            {[...overflow].map(([bin, n]) => (
              <text key={bin} x={PAD + bin * DOT} y={baseY - MAX_STACK * DOT - 8} textAnchor="middle">
                +{n}
              </text>
            ))}

            {labels.map(({ p, y }) => (
              <text key={p.token.mint} className="dot-label" x={Math.min(Math.max(p.x, 24), width - 24)} y={y} textAnchor="middle">
                {p.token.symbol}
              </text>
            ))}

            {placed.map((p) => {
              const level = p.token.severity === null ? 0 : SEVERITIES.indexOf(p.token.severity);
              return (
                <Link
                  key={p.token.mint}
                  href={`/token/?mint=${p.token.mint}`}
                  aria-label={`${p.token.symbol}: score ${p.score}, ${p.token.severity ? SEVERITY_LABEL[p.token.severity].toLowerCase() : "unscored"}`}
                  onFocus={() => setActive(p)}
                  onBlur={() => setActive(null)}
                >
                  <circle
                    className="dot"
                    cx={p.x}
                    cy={yOf(p.level)}
                    r={active?.token.mint === p.token.mint ? R + 1.5 : R}
                    fill={`var(--stage-${level})`}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                </Link>
              );
            })}
          </svg>
        )}
        {active && (
          <div className="tooltip" style={{ left: Math.min(Math.max(active.x, 70), Math.max(70, width - 70)), top: yOf(active.level) }} role="status">
            <strong>{active.score}</strong> {active.token.severity ? SEVERITY_LABEL[active.token.severity] : ""}
            <br />
            {active.token.symbol}
          </div>
        )}
      </div>
      {(scored.length === 0 || waiting > 0) && (
        <p className="section-note" style={{ marginTop: 8 }}>
          {scored.length === 0
            ? `A token is scored once it has ${overview.engine.minHistorySamples} readings to compare against, about an hour after collection starts. `
            : ""}
          {waiting > 0 ? `${waiting} ${waiting === 1 ? "token is" : "tokens are"} not on the board because ${waiting === 1 ? "it has" : "they have"} no score for the latest reading.` : ""}
        </p>
      )}
    </section>
  );
}
