import { DEMO_BUCKET_MS } from "@flowstate/market-data";
import { formatCompactUsd, shortenAddress } from "@flowstate/shared";
import { runDemo } from "./demo";

/**
 * CLI: `pnpm demo` — replay the synthetic demo universe and print what the
 * pipeline detected. All output is labelled as demo data.
 */
async function main(): Promise<void> {
  const result = await runDemo();
  const { store, tokens, summaries, startMs } = result;
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  const bucketOf = (ms: number) => Math.floor((ms - startMs) / DEMO_BUCKET_MS) - 1;
  const total = (pick: (s: (typeof summaries)[number]) => number) => summaries.reduce((a, s) => a + pick(s), 0);

  const line = "=".repeat(78);
  console.log(line);
  console.log(" FLOWSTATE — DEMO MODE. All figures below are SYNTHETIC fixture data,");
  console.log(" generated deterministically. They are not live or historical market data.");
  console.log(line);
  console.log(
    `cycles: ${summaries.length}   tokens: ${tokens.length}   snapshots: ${total((s) => s.snapshotsSaved)}   ` +
      `detections: ${total((s) => s.detections)}   fetch failures: ${total((s) => s.failures.length)}`,
  );

  console.log("\nAnomaly events");
  for (const event of store.events.values()) {
    const token = byMint.get(event.mint);
    const evidence = store.evidence.get(event.eventId);
    console.log(
      `  ${event.eventId}  ${(token?.symbol ?? "?").padEnd(8)} ${shortenAddress(event.mint)}  ` +
        `type=${event.anomalyType}  peak=${event.peakScore} (${event.peakSeverity})  status=${event.status}  ` +
        `detected@bucket ${bucketOf(event.detectedAt)}  updates=${event.updateCount}`,
    );
    if (evidence) {
      for (const f of evidence.factors) {
        const text =
          f.status === "available"
            ? `${f.points.toFixed(1)}/${f.maxPoints}`
            : `unavailable (${f.reason})`;
        console.log(`      ${f.type.padEnd(24)} ${text}`);
      }
      console.log(
        `      coverage=${(evidence.coverage * 100).toFixed(0)}%  confidence=${evidence.confidence.category}  ` +
          `score version=${evidence.scoreVersion}`,
      );
    }
  }

  console.log("\nTokens without events (highest score seen)");
  const withEvents = new Set([...store.events.values()].map((e) => e.mint));
  for (const token of tokens) {
    if (withEvents.has(token.mint)) continue;
    let max: number | null = null;
    let insufficient = 0;
    let notEligible = 0;
    for (const [key, d] of store.detections) {
      if (!key.startsWith(`${token.mint}|`)) continue;
      if (d.score === null) insufficient += 1;
      else max = Math.max(max ?? 0, d.score);
      if (!d.alertEligible) notEligible += 1;
    }
    console.log(
      `  ${token.symbol.padEnd(8)} scenario=${token.scenario.padEnd(14)} max score=${max ?? "—"}  ` +
        `insufficient-data evaluations=${insufficient}  not alert-eligible=${notEligible}`,
    );
  }

  console.log(`\nFeed notifications: ${store.notifications.length}`);
  console.log(`Alert deliveries queued: ${store.deliveries.size}`);
  for (const d of store.deliveries.values()) {
    console.log(
      `  ${d.ruleId.padEnd(24)} user=${d.userId.padEnd(16)} channel=${d.channel.padEnd(8)} ` +
        `token=${byMint.get(d.mint)?.symbol ?? "?"}  observed=${d.observed}  @bucket ${bucketOf(d.createdAt)}`,
    );
  }
  const sample = tokens[0];
  if (sample) {
    console.log(`\n(sample formatting: base volume ${formatCompactUsd(sample.baseVolumeUsd)} per 5 minutes per token)`);
  }
  console.log(`\n${line}\n END OF DEMO OUTPUT — synthetic data only.\n${line}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
