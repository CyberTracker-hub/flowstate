# FLOWSTATE — implementation status

Last updated: 2026-11-23 (milestone 2).

**Honest summary:** FLOWSTATE is a free public website and it is **online**:
<https://cybertracker-hub.github.io/flowstate/>. The collector has read the
live DexScreener API from GitHub (35 of 35 tokens, three cycles) and the site
shows those readings. Collection runs as a self-renewing loop on GitHub
Actions, one reading every five minutes. Not yet observed: real scores (a
token is scored after 12 readings) and the loop handing over to its successor.

Repository: <https://github.com/CyberTracker-hub/flowstate> (public).

## 0. Direction change in milestone 2 (owner's decision)

- **Free.** No subscriptions, no Stripe, no plans, no accounts.
- **A website, not an app.** Static pages; nothing to log in to.
- **Real data, no paid keys.** Birdeye needs a $199+/month plan for live
  monitoring, so the data source is now the public DexScreener API (no key).
- **GitHub for everything**, the same pattern as Cyber Tracker: a scheduled
  workflow collects data, GitHub Pages serves the site. Cost: $0.

Consequences: sign-in, wallet linking, billing, user alert rules, Telegram,
AI explanations and the admin panel from the original spec are **not built
and not planned**. Explanations are deterministic sentences, not AI.

## 1. Completed and verified

Verified = implemented, type-checked, and covered by tests that were run.

| Area | Where | Evidence |
|---|---|---|
| Anomaly engine: 6 signals, 0–100 score, bands, versioned config | `packages/anomaly-engine` | 55 tests |
| Event lifecycle, cooldown, one event per movement | `packages/anomaly-engine/src/lifecycle.ts` | tests |
| **DexScreener adapter**: parsing, pool pinning, token-level sums, batching, retries | `packages/market-data/src/dexscreener.ts` | 20 tests, incl. a fixture of real responses |
| **Deterministic explanations** of each signal | `packages/shared/src/explain.ts` | 4 tests |
| **Public data format** shared by collector and website | `packages/shared/src/public-data.ts` | used by both, type-checked |
| **JSON state store** (replaces the database): bounded, provider-safe | `apps/worker/src/json-store.ts` | tests |
| **Collector**: live cycle, publisher, CLI, synthetic preview mode | `apps/worker/src/{live,publish,collect}.ts` | 13 tests (live cycles on a DexScreener-shaped API, state store, publisher) |
| **Monitored tokens**: 35 mints | `config/tokens.json` | all 35 read successfully in the live runs |
| **Website**: Now, Tokens, Token, Events, How it works | `apps/web` | type-checked, static build, viewed at desktop and phone width, light and dark |
| **Live market figures**: the browser refreshes price, volume, trades and liquidity from DexScreener every 30 s, using the collector's own aggregation code | `apps/web/components/live.tsx` | observed on the deployed site: 4 requests per refresh, figures changed between refreshes |
| **Data-branch publishing** (one commit, replaced each run) | `scripts/publish-data.sh` | run against a local remote; round trip byte-identical |
| Demo fixtures, always labelled synthetic | `packages/market-data/src/demo.ts` | tests; website shows a "Demo data" banner |
| Retry/backoff, circuit breaker, number formatting, logging | `packages/shared`, `apps/worker` | tests |

### Verification evidence (commands actually run, 2026-11-23)

```text
$ pnpm install --frozen-lockfile  -> lockfile up to date (pnpm-lock.yaml now exists)
$ pnpm typecheck                  -> tsc exit 0 (TypeScript 6.0.3, strict)
$ pnpm test                       -> tests 166, pass 166, fail 0
     packages/anomaly-engine  55
     packages/shared          38
     packages/market-data     42
     apps/worker              31
$ pnpm demo                       -> 330 cycles, 8 synthetic tokens, 0 fetch failures
$ pnpm web:demo-data && pnpm web:build
                                  -> Next.js 16.4.6 static export, 8 pages, 0 type errors
$ scripts/publish-data.sh         -> 11 files pushed as a single commit to a local test remote
```

The new tests were checked against deliberate regressions: allowing partial
sums over pools, taking the price from the deepest instead of the most traded
pool, and accepting saved state from a different provider each made tests fail.

### Live API check (real requests, from a browser, 2026-11-23)

- `GET /token-pairs/v1/solana/{mint}` for 52 candidate mints: all returned 200.
- 300 real pools checked for how zero volume is encoded (omitted, never 0).
- `GET /latest/dex/pairs/solana/{…}`: 200, `{ schemaVersion, pairs }`.
- Response shapes, the absent-`volume.m5` behaviour, stale prices on idle
  pools and the one-pool limitation of `/tokens/v1` are recorded in
  `docs/integrations.md`. 17 candidates were dropped for thin liquidity or
  volume; 35 remain.

### First live run on GitHub (2026-11-23, 20:20–20:26 UTC)

```text
CI                    -> success (typecheck, 166 tests, demo run, site build)
Collect market data   -> success x3 (manual starts)
     cycle 1: 35/35 tokens read, 39 requests (pool selection + first reading)
     cycle 2: same 5-minute bucket -> nothing duplicated (idempotent)
     cycle 3: 35/35 tokens read, 4 requests, 2 readings per token
     data branch: exactly 1 commit after 3 runs
Deploy website        -> first run failed (Pages was not enabled yet), then success
Site                  -> home page and a token page loaded the real JSON
```

The first cycle exposed one wrong assumption: two tokens had an unknown
5-minute volume although their pools reported trades. A check of 300 real
pools showed DexScreener omits any volume window that rounds to $0.00. The
adapter was corrected (an omitted window is zero when the `volume` object is
present); after the fix no token had an unknown volume.

### The schedule did not deliver (2026-11-23, 20:20–21:48 UTC)

In 90 minutes GitHub started the five-minute schedule **once**. Tokens had 5
of the 12 readings needed for a score. A cron-per-reading design cannot work
on GitHub, so the collector became a self-renewing loop (owner's choice,
knowing it keeps a runner busy around the clock): one run reads every five
minutes for 5 h 20 min and starts its successor; the schedule remains as a
safety net. `scripts/collect-loop.sh` was tested locally for normal rounds, a
failing round among good ones, and a loop in which every round fails.

Observed on GitHub after the change: readings at 21:52:56, 21:55:31 and
22:00:32 UTC from one run (35 of 35 tokens each), and a second start while
the loop was running exited in 7 seconds without doing anything.

## 2. Not yet observed

| Item | Status |
|---|---|
| A loop handing over to its successor | First handover is due about 5 h 20 min after the loop started. |
| Real scores and events | Needs 12 readings per token (about an hour), a day for full baselines. |
| Behaviour over days | Rate limits, GitHub's tolerance of the loop, and threshold quality can only be judged with time. |

## 3. Next steps

1. Confirm tokens get scored (about an hour after the loop started) and that
   the first handover works.
2. After a day: review real scores and events; adjust thresholds if they are
   too noisy or too quiet.
3. Optional later: custom domain; a second data source for cross-checking
   prices; a public Telegram channel for events; token discovery beyond the
   fixed list.

## 4. Failing tests

None.

## 5. What is needed from the owner

Nothing. No API keys, no payments, no other accounts.

## 6. Decisions and assumptions to confirm

- **Website language is English** (crypto audience, and the existing product
  text). Easy to change.
- **Fixed token list.** 35 established tokens chosen for liquidity. New
  listings are not discovered automatically.
- **Pool selection:** up to 5 deepest pools per token, each at least $25K and
  5 % of the deepest; re-selected every 6 hours.
- **Materiality floors raised for live data** (`LIVE_ENGINE`): 5-minute volume
  baseline at least $1,000, buy-count baseline at least 5.
- **Event threshold 50**, events end after 15 minutes below it (unchanged).
- **Closed events are kept 7 days**; readings 24 hours (300 per token).
- **Data lives on a `data` branch with a single, replaced commit**, read by
  the site through `raw.githubusercontent.com`.

## 7. Known limitations

- Prices, volumes and liquidity are live (30-second refresh in the browser).
  **Scores and events are not**: a reading is taken every five minutes and the
  published files are cached for about five more, so they are up to about ten
  minutes behind the market.
- Activity in pools outside the pinned set is not counted.
- The large-transaction signal is off (no per-trade data), so the best
  possible signal coverage is 85 %. Buyer activity counts buys, not wallets.
- In a quiet market many tokens trade only a few times per five minutes; the
  buy/sell signal then reports "too few trades" instead of a value.
- Scoring thresholds have not been tuned on real data, and nothing here
  predicts price.
- The collector keeps a GitHub runner busy around the clock. Free on a public
  repository, but heavier than GitHub intends; they could throttle it.
- GitHub pauses scheduled workflows after 60 days without repository activity.
- No legal or regulatory review has been done.

## 8. Parked code (kept, tested, unused)

`packages/database` (PostgreSQL schema; `pnpm db:verify` still passes), the
Birdeye adapter, and plans/alert rules in `packages/shared`. Remove them if
the free-website direction is permanent.

## 9. How to continue

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm web:demo-data && pnpm web:dev    # preview with labelled demo data
```

Then follow `docs/deployment.md`.
