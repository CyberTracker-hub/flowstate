import { DEMO_ANOMALY_START, DEMO_BUCKET_MS, createDemoProvider, type DemoToken } from "@flowstate/market-data";
import type { AlertRule, PlanId } from "@flowstate/shared";
import { runCycle, type CycleSummary } from "./pipeline";
import { InMemoryStore } from "./store";

/**
 * DEMO MODE runner: replays the deterministic synthetic universe through the
 * real pipeline (same normalization, engine, lifecycle and alert code that
 * live mode uses) with a simulated clock. Nothing here touches a network.
 */

export interface DemoRunOptions {
  seed?: number;
  /** Number of 5-minute buckets to replay. */
  buckets?: number;
  startMs?: number;
}

export interface DemoRunResult {
  demo: true;
  store: InMemoryStore;
  tokens: readonly DemoToken[];
  summaries: CycleSummary[];
  startMs: number;
  endMs: number;
}

export const DEMO_DEFAULT_BUCKETS = DEMO_ANOMALY_START + 30;

function demoRule(id: string, userId: string, overrides: Partial<AlertRule>): AlertRule {
  return {
    id,
    userId,
    scope: { kind: "token", mint: "" },
    type: "anomaly_score",
    operator: "gte",
    threshold: 70,
    minConfidence: "medium",
    cooldownSeconds: 900,
    channel: "in_app",
    enabled: true,
    ...overrides,
  };
}

export function demoRules(tokens: readonly DemoToken[]): Array<{ rule: AlertRule; plan: PlanId }> {
  const mintOf = (scenario: DemoToken["scenario"]) => tokens.find((t) => t.scenario === scenario)?.mint ?? "";
  const spike = mintOf("volume_spike");
  const pull = mintOf("liquidity_pull");
  const quiet = mintOf("quiet_accumulation");
  const steady = mintOf("steady");
  return [
    { plan: "pro", rule: demoRule("demo-rule-score", "demo-user-pro", { scope: { kind: "token", mint: spike } }) },
    {
      // A free account cannot deliver to Telegram; this rule must never produce a delivery.
      plan: "free",
      rule: demoRule("demo-rule-free-telegram", "demo-user-free", {
        scope: { kind: "token", mint: spike },
        channel: "telegram",
      }),
    },
    {
      plan: "pro",
      rule: demoRule("demo-rule-liquidity", "demo-user-pro", {
        scope: { kind: "token", mint: pull },
        type: "liquidity_change",
        operator: "abs_gte",
        threshold: 30,
      }),
    },
    {
      plan: "elite",
      rule: demoRule("demo-rule-watchlist", "demo-user-elite", {
        scope: { kind: "watchlist", mints: [spike, quiet, steady] },
        type: "watchlist_high_severity",
        channel: "telegram",
      }),
    },
  ];
}

export async function runDemo(opts: DemoRunOptions = {}): Promise<DemoRunResult> {
  const startMs = opts.startMs ?? Date.UTC(2026, 0, 1);
  const buckets = opts.buckets ?? DEMO_DEFAULT_BUCKETS;
  let now = startMs;
  const provider = createDemoProvider({ seed: opts.seed, startMs, now: () => now });
  const store = new InMemoryStore();
  store.rules.push(...demoRules(provider.tokens));

  let nextId = 0;
  const newId = () => `demo-event-${++nextId}`;
  const summaries: CycleSummary[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    // Each cycle runs one second after its bucket closes.
    now = startMs + (bucket + 1) * DEMO_BUCKET_MS + 1_000;
    summaries.push(await runCycle(provider.listedMints(now), { provider, store, now: () => now, newId }));
  }
  return { demo: true, store, tokens: provider.tokens, summaries, startMs, endMs: now };
}
