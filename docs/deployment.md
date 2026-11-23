# Deployment: GitHub only, no cost

FLOWSTATE runs entirely on a public GitHub repository. There is no server,
no database, no account system and no API key.

```text
                    every ~5 min                       on push to main
          ┌──────────────────────────────┐      ┌──────────────────────────┐
          │ workflow: Collect market data │      │ workflow: Deploy website │
          │  restore state  (data branch) │      │  next build (static)     │
DexScreener ─► pnpm collect               │      │  upload + deploy Pages   │
 public API│  publish        (data branch) │      └────────────┬─────────────┘
          └───────────────┬──────────────┘                    │
                          ▼                                   ▼
        branch `data` (one commit, replaced each run)   GitHub Pages (static files)
          public/overview.json                                │
          public/tokens/<mint>.json  ◄──── fetched by the visitor's browser
          state.json
```

## One-time setup

1. Push this repository to GitHub as a **public** repository (Actions minutes
   and Pages are free for public repositories).
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Settings → Actions → General → Workflow permissions: **Read and write**
   (the collector pushes the `data` branch).
4. Actions → "Collect market data" → Run workflow, once, to create the `data`
   branch immediately instead of waiting for the first scheduled run.
5. Actions → "Deploy website" → Run workflow (it also runs on every push to
   `main` that touches the site).

The site is then at `https://<owner>.github.io/<repo>/`. The first scores
appear after 12 readings (about an hour); baselines are at full strength
after a day.

## What runs where

| Piece | Where | Command |
|---|---|---|
| Collector | `.github/workflows/collect.yml` | `pnpm collect` |
| Data publishing | `scripts/publish-data.sh` | replaces the `data` branch with one commit |
| Website | `.github/workflows/pages.yml` | `pnpm --filter @flowstate/web build` |
| Checks | `.github/workflows/ci.yml` | typecheck, tests, demo run, site build |

The `data` branch always holds exactly one commit, so readings every five
minutes do not grow the repository.

## Changing the monitored tokens

Edit `config/tokens.json` (mint address + ticker) and push. The next
collector run picks the token's pools and starts its baseline. A token that
is removed stops being read; an open event for it expires after an hour.

## Local use

```bash
pnpm install
pnpm test                 # 166 tests
pnpm web:demo-data        # synthetic preview data -> apps/web/public/data
pnpm web:dev              # http://localhost:3000 (shows a "Demo data" banner)
pnpm collect              # one real cycle against DexScreener -> .data/
```

To preview the site on real readings, run `pnpm collect` a few times and copy
`.data/public` to `apps/web/public/data`.

## Things to know

- **Scheduled runs are best-effort.** GitHub delays them under load and can
  skip one. The engine works on "the last N readings", so irregular spacing
  lowers the data-confidence indicator rather than breaking scores, and the
  website prints the age of its data.
- **GitHub pauses schedules in inactive repositories.** After 60 days without
  repository activity GitHub disables scheduled workflows and e-mails the
  owner; re-enable from the Actions tab.
- **The website reads the data branch through `raw.githubusercontent.com`**,
  which caches files for about five minutes. Together with the schedule, the
  page is typically 5–15 minutes behind the market. This is a monitor, not a
  trading terminal.
- **Rate limits.** A cycle makes about 7 requests (35 tokens); pool selection
  adds one request per token every six hours. DexScreener allows 300 requests
  a minute on these endpoints.
- **Custom domain.** Add it under Settings → Pages. `NEXT_PUBLIC_BASE_PATH`
  then becomes empty automatically (it comes from the Pages configuration).

## If you outgrow this

The collector only needs "run a command every five minutes and keep one JSON
file". Any scheduler can replace the workflow (a small VPS cron, Cloudflare
Workers cron with R2/KV) without touching the engine or the website: point
`NEXT_PUBLIC_DATA_URL` at wherever `public/` is served.
