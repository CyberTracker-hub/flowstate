# FLOWSTATE architecture

Status: describes what exists in the repository today, and marks what is planned.
See `IMPLEMENTATION_STATUS.md` for the feature-by-feature state.

## Shape

Since milestone 2 FLOWSTATE is a **free public website**: no accounts, no
billing, no database. A scheduled collector writes JSON files; a static
site reads them.

```text
apps/
  worker/            collector: ingestion -> detection -> events -> publish JSON   [implemented]
  web/               static website (Next.js export), reads the published JSON    [implemented]
packages/
  anomaly-engine/    deterministic scoring, confidence, lifecycle (no dependencies) [implemented]
  market-data/       normalized model, DexScreener adapter, demo fixtures           [implemented]
  shared/            explanations, public data format, retry/breaker, formatting    [implemented]
  database/          PostgreSQL schema                                              [parked, unused]
```

Dependency direction: `anomaly-engine` <- `shared` <- `market-data` <- `apps/*`.
The engine depends on nothing, so it can be tested and versioned in isolation.

### Static deployment

```text
DexScreener ──► collector (GitHub Actions, every ~5 min)
                  │  state.json            carried from run to run
                  ▼
              branch `data` ── public/overview.json, public/tokens/<mint>.json
                  ▲
                  │ fetched by the browser
              website (GitHub Pages, static files)
```

- `apps/worker/src/live.ts` runs one cycle: `prepare()` fetches every pinned
  pool in a few batched requests, then the unchanged pipeline (`runCycle`)
  processes each token.
- `apps/worker/src/json-store.ts` implements the `Store` interface on one
  JSON document. State from a different provider or schema is discarded, never
  mixed. The store is bounded: 300 readings per token, closed events for 7 days.
- `apps/worker/src/publish.ts` turns the state into the public files. The
  format is defined once in `packages/shared/src/public-data.ts` and imported
  by both the collector and the website.
- The website has no server code. It refetches the JSON every minute, shows
  the age of the data, and labels synthetic (demo) data with a banner.

## Data flow (one worker cycle)

```text
provider adapter ──► validate + normalize ──► snapshot (idempotent insert)
                                                   │
                         rolling history (24 h) ◄──┘
                                   │
                            anomaly engine  ──► score, factors, coverage, confidence
                                   │
                           event lifecycle  ──► create / update / resolve / expire (one open event per token)
                                   │
                          user alert rules  ──► queued deliveries (idempotency key)
```

Implemented in `apps/worker/src/pipeline.ts`. Guarantees, each covered by tests:

- A failing token or a failing provider never aborts the cycle.
- Re-running a cycle for the same data creates nothing twice. The "processed"
  marker is written last, so a crash mid-token is retried and every earlier
  effect is idempotent.
- A failed fetch produces no snapshot. Nothing is ever filled in.
- A circuit breaker stops calls to a provider that is down.

The pipeline talks to storage only through the `Store` interface
(`apps/worker/src/store.ts`). There are two implementations: in-memory
(demo run and tests) and the JSON state store used by the live collector.

## Data honesty rules

- **Missing is not zero.** Every metric carries a state: `ok`, `stale`,
  `missing`, `unsupported` or `error`. Only `ok` yields a number. In SQL a
  non-`ok` metric is `NULL` and the reason is kept in `metric_states`.
- **Synthetic is labelled.** Demo snapshots carry `synthetic: true` /
  `provider: "demo"`; tables have `is_synthetic`; events have
  `origin in ('live','backfill','demo')`.
- **The mint address is the identity.** Tickers and names are untrusted
  display text, sanitized on ingestion and never used as keys.

## Scoring model (`fs-score-1.0.0`)

Six signals, each producing an intensity in 0..1 that is multiplied by its
weight. Weights are product parameters, not validated predictors; they are
configurable and versioned, and the version is stored with every event.

| Factor | Max | How it is measured |
|---|---:|---|
| Volume | 25 | Current bucket vs. the median of the last 1 h and of the last 24 h; the smaller ratio is used, and a robust z-score (median/MAD) gates it |
| Buyer activity | 20 | Same method on unique buyers when the provider deduplicates wallets, otherwise on buy counts (the basis is recorded) |
| Buy/sell imbalance | 15 | (buys − sells)/(buys + sells) vs. the token's own pooled baseline; deviations inside the sampling-noise band 2/√n score zero |
| Liquidity | 15 | % change vs. the median of recent buckets from the same source; a change of reporting source makes the signal unavailable |
| Large transaction | 15 | Largest trade as a share of liquidity, and vs. the token's typical largest trade; unsupported without per-trade data |
| Price-volume divergence | 10 | One of volume / absolute price move is far above its baseline while the other is not |

**Missing-signal policy.** A signal that cannot be computed is marked
unavailable with a reason. It contributes neither points nor weight:

```text
coverage = available weight / total weight
score    = round(raw points / available weight × 100)     if coverage ≥ 40 %
score    = none ("insufficient data")                      if coverage < 40 %
alerts and events are only possible when coverage ≥ 60 % and data is fresh
```

Known limitation: normalizing over available weight assumes the missing
signals would have scored in proportion to the available ones. That is why
coverage is always shown next to the score and feeds the confidence indicator.

**Bands.** 0–24 normal, 25–49 elevated, 50–69 unusual, 70–84 high, 85–100 extreme.
The score measures how unusual current activity is relative to the token's own
recent history. It is not a probability and not a price forecast.

**Confidence** (`insufficient` / `low` / `medium` / `high`) is computed from
freshness, sample size, gap-free history, metric coverage and, when two
providers are available, their agreement. It is weighted toward the weakest
component and is not a calibrated probability.

## Event lifecycle

`detected → active → updated → resolved | expired`, implemented as a pure
function in `packages/anomaly-engine/src/lifecycle.ts`.

- An event opens when an alert-eligible score reaches 50.
- Further qualifying evaluations extend the same event. A material change
  (≥ 5 points or a new band) is recorded as an update, not a new discovery.
- It resolves after 15 minutes below threshold and expires after 60 minutes
  without usable data.
- Notification cooldown is 15 minutes per token and anomaly type. A new
  notification inside the cooldown is allowed only when severity is higher
  than what the user was last told.
- The database enforces at most one open event per token with a partial
  unique index.

## Live data specifics

- **Token-level figures from pool-level data.** DexScreener reports per pool.
  Per token the collector pins up to five of its deepest pools (token as base
  asset; each at least $25K and 5 % of the deepest) and sums their 5-minute
  volume, trade counts and liquidity. Pins are re-selected every six hours.
  The identity of the pinned set is the snapshot's `poolId`, so a change of
  set makes the liquidity signal report a "reporting change" rather than a
  false liquidity move.
- **No partial sums.** If a pinned pool is missing from a response, the summed
  metrics are unknown for that reading.
- **Price** comes from the most traded pinned pool; idle pools keep stale prices.
- **Engine parameters for live data** (`LIVE_ENGINE`, version
  `fs-score-1.0.0+dex.1`): the materiality floors are raised (a 5-minute
  volume baseline is never taken to be below $1,000, a buy-count baseline never
  below 5). ASSUMPTION, not tuned on outcomes.
- **Coverage.** The source has no per-trade data, so the large-transaction
  signal (15 points) is unsupported and the best possible coverage is 85 %.
  Buyer activity is measured in buy counts, not unique wallets.
- **Explanations** are deterministic sentences built from each factor's own
  numbers (`packages/shared/src/explain.ts`). There is no AI in the product.

## Not part of the free website

Accounts, billing, user alert rules, Telegram delivery and AI explanations
were in the original specification and are intentionally not built. The plan
and alert-rule code in `packages/shared`, the Birdeye adapter and the
PostgreSQL schema remain in the repository, tested but unused.
