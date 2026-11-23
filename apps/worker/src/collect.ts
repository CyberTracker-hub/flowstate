import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicData } from "./publish";
import type { PersistedState } from "./json-store";
import { createJsonLogger } from "./logger";
import { parseTokenConfig, runDemoReplay, runLiveCycle } from "./live";

/**
 * CLI: `pnpm collect` — run one live cycle and write
 *
 *   <dir>/state.json                 worker state (carried to the next run)
 *   <dir>/public/overview.json       what the website's feed and token list read
 *   <dir>/public/tokens/<mint>.json  one file per token
 *
 * `pnpm collect --demo` writes the same files from synthetic demo data
 * (flagged as synthetic) for previewing the website without a network.
 *
 * Environment: FLOWSTATE_DATA_DIR (default ".data"), FLOWSTATE_TOKENS
 * (default "config/tokens.json").
 */

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A corrupt state file must not block collection forever: start over.
    return undefined;
  }
}

/** Write via a temporary file so a crash never leaves a half-written JSON. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

async function writeOutputs(dir: string, state: PersistedState, data: PublicData): Promise<void> {
  const tokensDir = path.join(dir, "public", "tokens");
  await mkdir(tokensDir, { recursive: true });
  const wanted = new Set<string>();
  for (const [mint, detail] of data.details) {
    wanted.add(`${mint}.json`);
    await writeJson(path.join(tokensDir, `${mint}.json`), detail);
  }
  for (const name of await readdir(tokensDir)) {
    if (!wanted.has(name)) await rm(path.join(tokensDir, name), { force: true });
  }
  await writeJson(path.join(dir, "public", "overview.json"), data.overview);
  await writeJson(path.join(dir, "state.json"), state);
}

async function main(): Promise<void> {
  const demo = process.argv.includes("--demo");
  const dir = path.resolve(process.env.FLOWSTATE_DATA_DIR ?? ".data");
  const log = createJsonLogger({ service: "collect", mode: demo ? "demo" : "live" });

  if (demo) {
    const { state, data } = await runDemoReplay({ now: Date.now() });
    await writeOutputs(dir, state, data);
    log.info("demo data written (SYNTHETIC, not market data)", { dir, tokens: data.overview.tokens.length, events: data.overview.events.length });
    return;
  }

  const tokensFile = path.resolve(process.env.FLOWSTATE_TOKENS ?? "config/tokens.json");
  const tokens = parseTokenConfig(JSON.parse(await readFile(tokensFile, "utf8")));
  const previousState = await readJson(path.join(dir, "state.json"));
  if (previousState === undefined) log.warn("state.json was not valid JSON; starting from empty");

  const result = await runLiveCycle({ tokens, previousState: previousState ?? null, logger: log });
  await writeOutputs(dir, result.state, result.data);

  const { summary } = result;
  log.info("collect finished", {
    dir,
    startedFresh: result.startedFresh,
    requests: result.requests,
    tokens: summary.tokens,
    failed: summary.failures.length,
    snapshotsSaved: summary.snapshotsSaved,
    alreadyProcessed: summary.alreadyProcessed,
    detections: summary.detections,
    eventsCreated: summary.eventsCreated,
    eventsResolved: summary.eventsResolved,
    health: result.data.overview.health.status,
    openEvents: result.data.overview.events.filter((e) => e.status !== "resolved" && e.status !== "expired").length,
  });
  // The outputs above always describe what happened, including a provider
  // outage, so the website can say so. Only a run that could not reach the
  // provider for ANY token on its very first attempt is treated as a failure
  // of the job itself (nothing useful was produced).
  if (result.startedFresh && summary.failures.length === summary.tokens) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
