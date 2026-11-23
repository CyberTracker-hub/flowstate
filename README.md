# FLOWSTATE

Free, read-only Solana flow monitor. Every five minutes it compares each
monitored token's trading with that token's own recent history, scores how
unusual it is (0–100), and publishes the result as a static website.

FLOWSTATE measures; it does not predict. It does not trade, hold keys, or
ask for an account. Nothing in this project is financial advice.

> **Status:** the engine, the live data adapter, the collector and the
> website are built and tested. The first run on GitHub (collector schedule
> and Pages deployment) is the remaining step. See
> [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for exactly what has
> and has not been verified.

## How it works

- **Data:** the public [DexScreener API](https://docs.dexscreener.com/api/reference)
  (no key, no cost). Per token, the deepest pools are pinned and their
  5-minute volume, trades and liquidity are summed.
- **Engine:** six explainable signals, a 0–100 score, explicit handling of
  missing data, a separate data-confidence indicator, one event per movement.
- **Collector:** a scheduled GitHub Actions job runs one cycle and writes
  JSON to the repository's `data` branch. No database.
- **Website:** a static Next.js export on GitHub Pages that reads that JSON
  in the browser. Pages: Now, Tokens, Token, Events, How it works.

## Quick start

Requires Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm typecheck && pnpm test   # 166 tests
pnpm web:demo-data            # synthetic preview data (labelled as demo)
pnpm web:dev                  # http://localhost:3000
pnpm collect                  # one real cycle against DexScreener -> .data/
```

Putting it online: [`docs/deployment.md`](docs/deployment.md).

## Layout

```text
apps/web                  static website (Next.js export)
apps/worker               pipeline, JSON state store, publisher, collector CLI
packages/anomaly-engine   scoring, confidence, event lifecycle (no dependencies)
packages/market-data      normalized model, DexScreener adapter, demo fixtures
packages/shared           explanations, public data format, retry, formatting
config/tokens.json        the monitored tokens
scripts/publish-data.sh   publishes the data branch
docs/                     architecture, integrations, deployment
```

Parked, not used by the free website: `packages/database` (PostgreSQL schema),
the Birdeye adapter, and the plan/alert-rule code in `packages/shared`. They
remain tested but nothing in the deployed path calls them.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — modules, data flow, scoring model
- [`docs/integrations.md`](docs/integrations.md) — data source, verification status
- [`docs/deployment.md`](docs/deployment.md) — running it on GitHub for free
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — progress and evidence
