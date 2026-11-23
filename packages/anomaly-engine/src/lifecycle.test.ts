import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "./config";
import { DEFAULT_LIFECYCLE, advance, expireIfStale, type EventState, type PriorNotification } from "./lifecycle";
import { severityForScore } from "./scoring";
import type { DetectionResult } from "./types";

const MIN = 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function detection(at: number, score: number | null, overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    mint: "MintA",
    evaluatedAt: at,
    scoreVersion: DEFAULT_CONFIG.version,
    status: score === null ? "insufficient_data" : "scored",
    score,
    severity: score === null ? null : severityForScore(score),
    rawPoints: score ?? 0,
    availableMaxPoints: 100,
    totalMaxPoints: 100,
    coverage: 1,
    freshnessMs: 0,
    alertEligible: score !== null,
    dominantFactor: "volume",
    factors: [],
    confidence: {
      category: "high",
      index: 0.9,
      components: { freshness: 1, sampleSize: 1, historicalCoverage: 1, metricCoverage: 1, providerConsistency: null },
    },
    ...overrides,
  };
}

function idGen() {
  let n = 0;
  return () => `evt-${++n}`;
}

describe("anomaly lifecycle", () => {
  it("does nothing while the score is below the event threshold", () => {
    const d = advance(null, detection(START, 49), null, idGen());
    assert.equal(d.action, "none");
    assert.equal(d.state, null);
    assert.equal(d.notify, false);
  });

  it("creates one event and notifies once when a score first qualifies", () => {
    const d = advance(null, detection(START, 62), null, idGen());
    assert.equal(d.action, "create");
    assert.equal(d.state?.status, "detected");
    assert.equal(d.state?.anomalyType, "volume");
    assert.equal(d.notify, true);
    assert.equal(d.notifyReason, "new_event");
  });

  it("a sustained movement produces one event and one notification, not a flood", () => {
    const newId = idGen();
    let state: EventState | null = null;
    let notifications = 0;
    let creations = 0;
    for (let i = 0; i < 24; i++) {
      const d = advance(state, detection(START + i * 5 * MIN, 62 + (i % 3)), null, newId);
      if (d.action === "create") creations += 1;
      if (d.notify) notifications += 1;
      state = d.state;
    }
    assert.equal(creations, 1);
    assert.equal(notifications, 1);
    assert.equal(state?.status, "active");
    assert.equal(state?.eventId, "evt-1");
  });

  it("marks a material score change as an update of the same event", () => {
    const newId = idGen();
    const created = advance(null, detection(START, 55), null, newId);
    const updated = advance(created.state, detection(START + 5 * MIN, 64), null, newId);
    assert.equal(updated.action, "update");
    assert.equal(updated.state?.status, "updated");
    assert.equal(updated.state?.eventId, created.state?.eventId);
    assert.equal(updated.state?.updateCount, 1);
    assert.equal(updated.notify, false, "same severity band must not re-notify");
  });

  it("notifies again when severity increases materially, but only once per level", () => {
    const newId = idGen();
    let d = advance(null, detection(START, 55), null, newId); // unusual
    d = advance(d.state, detection(START + 5 * MIN, 78), null, newId); // high
    assert.equal(d.notify, true);
    assert.equal(d.notifyReason, "severity_increase");
    d = advance(d.state, detection(START + 10 * MIN, 60), null, newId); // back to unusual
    assert.equal(d.notify, false);
    d = advance(d.state, detection(START + 15 * MIN, 79), null, newId); // high again
    assert.equal(d.notify, false, "already notified at this severity");
    d = advance(d.state, detection(START + 20 * MIN, 90), null, newId); // extreme
    assert.equal(d.notify, true);
    assert.equal(d.state?.peakScore, 90);
    assert.equal(d.state?.peakSeverity, "extreme");
  });

  it("resolves only after the score stays below threshold long enough", () => {
    const newId = idGen();
    let d = advance(null, detection(START, 60), null, newId);
    d = advance(d.state, detection(START + 5 * MIN, 30), null, newId);
    assert.equal(d.action, "hold");
    assert.equal(d.state?.belowThresholdSince, START + 5 * MIN);
    d = advance(d.state, detection(START + 10 * MIN, 30), null, newId);
    assert.equal(d.action, "hold");
    d = advance(d.state, detection(START + 20 * MIN, 30), null, newId);
    assert.equal(d.action, "resolve");
    assert.equal(d.state?.status, "resolved");
    assert.equal(d.state?.resolvedAt, START + 20 * MIN);
    assert.equal(d.notify, false);
  });

  it("a brief dip does not resolve the event", () => {
    const newId = idGen();
    let d = advance(null, detection(START, 60), null, newId);
    d = advance(d.state, detection(START + 5 * MIN, 40), null, newId);
    d = advance(d.state, detection(START + 10 * MIN, 61), null, newId);
    assert.equal(d.state?.belowThresholdSince, null);
    assert.notEqual(d.state?.status, "resolved");
  });

  it("suppresses the notification for a new event inside the cooldown window", () => {
    const prior: PriorNotification = { at: START, severity: "unusual" };
    const d = advance(null, detection(START + 10 * MIN, 58), prior, idGen());
    assert.equal(d.action, "create");
    assert.equal(d.notify, false);
    assert.equal(d.state?.lastNotifiedAt, null);
  });

  it("allows a notification inside the cooldown when severity is higher than before", () => {
    const prior: PriorNotification = { at: START, severity: "unusual" };
    const d = advance(null, detection(START + 10 * MIN, 88), prior, idGen());
    assert.equal(d.notify, true);
    assert.equal(d.notifyReason, "severity_increase");
  });

  it("notifies a suppressed event once the cooldown has elapsed", () => {
    const newId = idGen();
    const prior: PriorNotification = { at: START, severity: "unusual" };
    let d = advance(null, detection(START + 10 * MIN, 58), prior, newId);
    assert.equal(d.notify, false);
    d = advance(d.state, detection(START + 14 * MIN, 58), prior, newId);
    assert.equal(d.notify, false);
    d = advance(d.state, detection(START + 16 * MIN, 58), prior, newId);
    assert.equal(d.notify, true);
    assert.equal(d.notifyReason, "cooldown_elapsed");
    d = advance(d.state, detection(START + 21 * MIN, 58), prior, newId);
    assert.equal(d.notify, false);
  });

  it("notifies normally for a new event after the cooldown", () => {
    const prior: PriorNotification = { at: START, severity: "high" };
    const d = advance(null, detection(START + DEFAULT_LIFECYCLE.cooldownMs, 58), prior, idGen());
    assert.equal(d.notify, true);
    assert.equal(d.notifyReason, "new_event");
  });

  it("holds an open event when data becomes insufficient, and expires it eventually", () => {
    const newId = idGen();
    let d = advance(null, detection(START, 60), null, newId);
    d = advance(d.state, detection(START + 5 * MIN, null), null, newId);
    assert.equal(d.action, "hold");
    assert.equal(d.state?.status, "detected");
    const early = expireIfStale(d.state, START + 30 * MIN);
    assert.equal(early.action, "none");
    const late = expireIfStale(d.state, START + 61 * MIN);
    assert.equal(late.action, "expire");
    assert.equal(late.state?.status, "expired");
  });

  it("does not create events from results that are not alert-eligible", () => {
    const d = advance(null, detection(START, 95, { alertEligible: false }), null, idGen());
    assert.equal(d.action, "none");
  });

  it("starts a fresh event after the previous one was resolved", () => {
    const newId = idGen();
    let d = advance(null, detection(START, 60), null, newId);
    d = advance(d.state, detection(START + 5 * MIN, 10), null, newId);
    d = advance(d.state, detection(START + 25 * MIN, 10), null, newId);
    assert.equal(d.state?.status, "resolved");
    const next = advance(d.state, detection(START + 60 * MIN, 66), { at: START, severity: "unusual" }, newId);
    assert.equal(next.action, "create");
    assert.equal(next.state?.eventId, "evt-2");
    assert.equal(next.notify, true);
  });
});
