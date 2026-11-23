# FLOWSTATE — implementation status

Last updated: 2026-11-23 (milestone 2).

**Honest summary:** FLOWSTATE is now a free public website instead of a
subscription app. The engine, a live data adapter for a free data source, the
collector and the website are built and tested locally. **Nothing is online
yet:** the GitHub workflows have never run, so the collector has not yet
read the live API from GitHub and the site has not been deployed.

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
| **Monitored tokens**: 35 mints | `config/tokens.json` | every mint resolved on the live API on 2026-11-23 |
| **Website**: Now, Tokens, Token, Events, How it works | `apps/web` | type-checked, static build, viewed at desktop and phone width, light and dark |
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

The new tests were checked against deliberate regressions: treating a missing
5-minute volume as zero, allowing partial sums over pools, taking the price
from the deepest instead of the most traded pool, and accepting saved state
from a different provider each made tests fail.

### Live API check (real requests, from a browser, 2026-11-23)

- `GET /token-pairs/v1/solana/{mint}` for 52 candidate mints: all returned 200.
- `GET /latest/dex/pairs/solana/{…}`: 200, `{ schemaVersion, pairs }`.
- Response shapes, the absent-`volume.m5` behaviour, stale prices on idle
  pools and the one-pool limitation of `/tokens/v1` are recorded in
  `docs/integrations.md`. 17 candidates were dropped for thin liquidity or
  volume; 35 remain.

## 2. Implemented but NOT verified in its real environment

| Item | Why unverified |
|---|---|
| Collector against the live API | The build environment could not reach `api.dexscreener.com` from its shell. The adapter is tested on captured real responses and on a stand-in API, but `pnpm collect` has never completed a real cycle. |
| `collect.yml`, `pages.yml`, `ci.yml` | Never executed: the repository is not on GitHub yet. |
| DexScreener from GitHub runners | Unknown whether Cloudflare accepts requests from GitHub's runner addresses. |
| Website reading `raw.githubusercontent.com` | The site was only viewed with local demo data. |
| Scoring on real markets | Thresholds are reasoned defaults; no real anomaly has been observed yet. |

## 3. Not started / next steps, in order

1. **Create the GitHub repository and push** (needs the owner: see section 5).
2. Enable Pages (source: GitHub Actions) and read/write workflow permissions.
3. Run "Collect market data" once; confirm a real cycle: all 35 tokens read,
   `data` branch created.
4. Run "Deploy website"; open the site and confirm it loads the real JSON.
5. After about an hour: confirm tokens are being scored. After a day: review
   real scores and events and adjust thresholds if they are too noisy or too quiet.
6. Optional later: custom domain; a second data source for cross-checking
   prices; a public Telegram channel for events; token discovery beyond the
   fixed list.

## 4. Failing tests

None.

## 5. What is needed from the owner

- **A GitHub repository** to push to (public, e.g. `flowstate`). The build
  session cannot create one.
- No API keys, no payments, no other accounts.

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

- The page is typically 5–15 minutes behind the market (schedule delays plus
  about five minutes of CDN caching). It is a monitor, not a trading terminal.
- Activity in pools outside the pinned set is not counted.
- The large-transaction signal is off (no per-trade data), so the best
  possible signal coverage is 85 %. Buyer activity counts buys, not wallets.
- In a quiet market many tokens trade only a few times per five minutes; the
  buy/sell signal then reports "too few trades" instead of a value.
- Scoring thresholds have not been tuned on real data, and nothing here
  predicts price.
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
