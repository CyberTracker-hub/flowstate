# Integrations and verification status

Last check: 2026-11-23.

"Live verified" means real requests were made and the real responses were
inspected. The website uses exactly one external service.

| Provider | Purpose | Code | Live verified |
|---|---|---|---|
| **DexScreener** | Market data for every token | `packages/market-data/src/dexscreener.ts` | **Yes**, from a browser (see below). Not yet from a GitHub Actions runner. |
| GitHub Actions / Pages | Scheduler and hosting | `.github/workflows/*` | Not yet (workflows have not run) |
| Birdeye | (parked) | `packages/market-data/src/birdeye.ts` | No. Needs a paid plan for live monitoring; not used. |
| Helius, Jupiter, Anthropic, Stripe, Supabase, Telegram | (not used) | — | — |

## DexScreener

Source: <https://docs.dexscreener.com/api/reference>. Free, no API key.

**Endpoints in use**

| Endpoint | Used for | Verified behaviour |
|---|---|---|
| `GET /token-pairs/v1/solana/{mint}` | selecting a token's pools (every 6 h) | array, at most 30 pools, not ordered by liquidity |
| `GET /latest/dex/pairs/solana/{a,b,…}` | reading the pinned pools (every cycle, 30 per request) | `{ schemaVersion, pairs }`, pools returned in request order |

Both answered `200` with `cache-control: public, max-age=30` and
`access-control-allow-origin: *`.

**What the real responses showed (2026-11-23)**

- `priceUsd` and `priceNative` are strings; all other figures are numbers.
- A volume window that rounds to $0.00 is **omitted**, never sent as 0.
  Checked on 300 real pools: no window was ever present with value 0, the
  smallest present value was 0.01, and every window without trades was
  absent. The adapter therefore reads an omitted window as zero when the
  `volume` object is present, and as unknown when the object itself is missing.
- `marketCap`/`fdv` are absent for some pools (e.g. SOL), `liquidity` for a few.
- `GET /tokens/v1/solana/{mints}` returns ONE pool per token, and often not a
  representative one (seen: a $14K pool for a token with $5M of liquidity
  elsewhere). It is therefore not used.
- Pools of one token can disagree on price: an idle pool quoted 0.9989 while
  the active pools traded at 0.8897.
- All 35 mints in `config/tokens.json` resolved to pools. Four real pool
  objects are kept as a test fixture (`dexscreener.fixture.ts`).

**Not available:** unique wallets, holder counts, individual trades. Reported
as unsupported; never estimated.

**Rate limits:** documented as 300 requests/minute for the pair endpoints. A
cycle needs about 7 requests.

**Open risk:** the API sits behind Cloudflare and could refuse requests from
GitHub's shared runner addresses. This can only be confirmed by the first
workflow run. If it happens, the collector can run from any other scheduler
(see `docs/deployment.md`).

**Attribution:** the website credits and links DexScreener in its footer and
on the method page.

# Parked integrations

The sections below describe providers evaluated in milestone 1. None of them
is used by the free website.

## Birdeye

Source: <https://data.birdeye.so/docs> (docs.birdeye.so redirects there).

**Endpoint in use** — `GET https://public-api.birdeye.so/defi/token_overview`

- Headers: `X-API-KEY` (required), `x-chain: solana`.
- Query: `address` (required), `frames` (comma-separated intervals, e.g. `5m`).
- Cost: 18 compute units (CU) per request.
- Fields consumed: `price`, `liquidity`, `marketCap`, `holder`,
  `lastTradeUnixTime`, `v{frame}USD`, `trade{frame}`, `buy{frame}`,
  `sell{frame}`, and on Solana `uniqueBuyer{frame}` / `uniqueSeller{frame}`.
- Not available from this endpoint: per-trade data. `largestTradeUsd` is
  therefore reported as **unsupported**, and the large-transaction signal
  (15 of 100 points) is unavailable in live mode until a transaction source
  is added.

**Plans (monthly)**

| Plan | Price | Included CU | Rate limit | WebSocket |
|---|---:|---:|---|---|
| Standard | $0 | 30,000 | 1 rps | not listed |
| Lite | $39 | 2,500,000 | 15 rps | not listed |
| Starter | $99 | 8,000,000 | 15 rps | not listed |
| Premium | $199 | 20,000,000 | 50 rps / 1000 rpm | yes (500 connections) |
| Business | $499 | 60,000,000 | 100 rps / 1500 rpm | yes (2000 connections) |

**Budget for the planned polling design** (`estimateMonthlyComputeUnits`):

| Universe | Interval | CU / month | Smallest plan that fits |
|---|---|---:|---|
| 200 tokens | 5 min | 31,104,000 | Business ($499) |
| 100 tokens | 5 min | 15,552,000 | Premium ($199) |
| 25 tokens | 5 min | 3,888,000 | Starter ($99) |
| 16 tokens | 5 min | 2,488,320 | Lite ($39) |

The free plan covers about 1,666 requests per month, which is not enough for
any live monitoring. **The 100–300 token target needs a paid Birdeye plan.**
`MONITORED_TOKENS_MAX` and `POLL_INTERVAL_SECONDS` must be set from the plan.

**Assumptions and open points**

- The response envelope is treated as `{ success, data }`. `data` is confirmed
  by the reference; the `success` flag is handled leniently (only an explicit
  `false` is an error).
- The docs do not state the HTTP status or headers for rate limiting. The
  adapter treats 429 as rate-limited and honours `Retry-After` if present.
- Windowed metrics are rolling ("last 5 minutes") at request time. Snapshots
  are aligned to the 5-minute bucket boundary, so a poll that is late by a few
  seconds describes a slightly shifted window.
- `GET /defi/v3/token/trade-data/multiple` may cut CU cost by batching. Not
  yet read or tested.
- WebSocket streams need Premium or higher. The MVP polls.

## Helius

Source: <https://www.helius.dev/docs/billing/plans>.

| Plan | Price | Credits / month | RPC | DAS / Enhanced API | Enhanced WebSockets | LaserStream |
|---|---:|---:|---|---|---|---|
| Free | $0 | 1M | 10 req/s | 2 req/s | no | no |
| Developer | $49 | 10M | 50 req/s | 10 req/s | yes | devnet only |
| Business | $499 | 100M | 200 req/s | 50 req/s | yes | devnet + mainnet |
| Professional | $999 | 200M | 500 req/s | 100 req/s | yes | devnet + mainnet |

Not implemented. Intended use: token metadata (DAS) and transaction-level data
for the large-transaction signal. Authentication details and SDK version have
not been verified.

## Configuring the Birdeye key

1. Create an account and API key in the Birdeye data portal.
2. Put it in `.env` as `BIRDEYE_API_KEY` (server and worker only).
3. Choose `MONITORED_TOKENS_MAX` and `POLL_INTERVAL_SECONDS` to fit the plan's CU.
4. First live check to run once a key exists: fetch one snapshot for wrapped
   SOL and confirm every consumed field arrives with the expected type.
