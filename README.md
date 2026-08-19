# InsiderScope

Solana memecoin insider tracker. It finds the **real insiders** (not sniper bots) of tokens that
reached **$10M+ market cap** from historical on-chain data, watches those wallets **live** via
Helius webhooks, fires a **Telegram alert within seconds** when they buy, **auto-follows wallet
rotations** (SOL moved to a fresh wallet), and shows every insider's profile on a dark terminal
**dashboard**.

```
                    ┌──────────────────────────────────────────────────────┐
  DexScreener ──►   │  apps/analyzer (CLI)                                 │
  Helius Enhanced ► │  import-tokens → early-buyers → funding → score      │──► Postgres
  Binance klines ─► │  (historical pipeline, idempotent, page-capped)      │
                    └──────────────────────────────────────────────────────┘
                    ┌──────────────────────────────────────────────────────┐
  Helius webhook ─► │  apps/ingest (Fastify + BullMQ + grammY)             │──► Telegram
  PumpPortal WS ──► │  classify → persist → enrich MC → alert queue        │──► Postgres/Redis
                    │  rotation tracking · reconcile · nightly rescore     │
                    └──────────────────────────────────────────────────────┘
                    ┌──────────────────────────────────────────────────────┐
  Postgres ───────► │  apps/web (Next.js 14) — overview / insiders /       │
                    │  insider profile / token pages, 5s live feed         │
                    └──────────────────────────────────────────────────────┘
```

## Monorepo

| Package | What it is |
|---|---|
| `apps/analyzer` | Historical analysis CLIs (Phase 1) |
| `apps/ingest` | Live tracking: webhook, Telegram bot, jobs, PumpPortal (Phases 2 + 4.1/4.2) |
| `apps/web` | Dashboard (Phase 3) |
| `packages/db` | Drizzle ORM schema, migrations, Postgres client |
| `packages/shared` | Domain library: Helius client, swap normalization, launch detection, MC derivation, scorer, funding graph |
| `fixtures/` | Mock Helius/PumpPortal/DexScreener payloads for tests, sample CSV, demo seed SQL |

## Requirements

- Node.js ≥ 20, pnpm ≥ 9
- Docker (Postgres 16 + Redis 7 via `docker compose up -d`)
- A [Helius](https://helius.dev) API key — **the free tier will not survive deep historical
  crawls**; the Developer plan is the realistic minimum. Every crawl in this repo is page-capped
  (see tunables) so a single token analysis stays bounded.
- A Telegram bot token (optional for development — without it, alerts dry-run to the ingest logs)

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in HELIUS_API_KEY (and Telegram vars for live alerts)
docker compose up -d          # postgres :5432 + redis :6379
pnpm db:migrate               # apply committed Drizzle migrations
pnpm test                     # 97 unit/integration tests (DB suites need DATABASE_URL)
```

Preview the dashboard with demo data (no API keys needed):

```bash
psql postgres://insiderscope:insiderscope@localhost:5432/insiderscope -f fixtures/seed-demo.sql
pnpm dev:web                  # http://localhost:3000
```

## Phase 1 — historical pipeline

Typical run, end to end:

```bash
# 1. Seed candidate tokens (CSV: mint[,symbol[,ath_mc_usd[,name]]], header optional)
pnpm analyzer import-tokens fixtures/tokens.sample.csv

# 2. (optional, best-effort) refresh ATHs + scan DexScreener boosted/profile feeds
pnpm analyzer discover

# 3. Crawl launch history and extract early buyers into positions
pnpm analyzer early-buyers 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump
pnpm analyzer early-buyers --all          # every 'candidate' token

# 4. Build the funding graph and mark creator-linked positions
pnpm analyzer funding <wallet-address>
pnpm analyzer funding --all               # every wallet with analyzed positions

# 5. Score everything (fetches each wallet's FULL swap history — losers included)
pnpm analyzer score                       # or: pnpm analyzer score <wallet>
```

All commands are idempotent (upserts) — re-running never duplicates rows.

How the crawl stays cheap: for pump.fun tokens the analyzer never crawls the mint (a $10M token's
mint history is millions of txs). It derives the **bonding curve PDA** and drains that instead —
the bonding phase is bounded and contains every early buyer. Raydium-native tokens fall back to
the AMM pool address taken from the DexScreener pair. Historical **entry market caps are derived
from the swaps themselves** (`SOL in / tokens out × supply`) and converted to USD through an
hourly SOL/USD cache backfilled from Binance klines — DexScreener has no history.

### Scoring model

```
score = 25·repeat + 25·creator_link + 20·win_rate + 15·selectivity + 15·timing   (0–100)

repeat        early in how many different $10M+ tokens: 1 → 0.3, 2 → 0.7, 3+ → 1.0
creator_link  share of big-token positions with a ≤2-hop transfer link (or shared
              funder) to the token creator; CEX wallets are terminal graph nodes
win_rate      Laplace-smoothed (wins+1)/(decided+2) over ALL traded tokens
              (survivorship countermeasure: the full swap history is fetched)
selectivity   1 − min(1, total_trades/200)
timing        median entry delay: 5s–10min ideal; <3s = sniper bot → 0,
              UNLESS the wallet is creator-linked (dev bundles are real insiders)
```

Auto-blacklist: `total_trades > 500` · `win rate < 30% with ≥5 decided positions` ·
`median entry < 3s without a creator link`. Tiers: **≥ 70 insider** (requires ≥ 3 early
positions, otherwise capped at watch), **50–70 watch**. Scored detail is persisted to
`wallets.score_breakdown` and rendered on the dashboard.

## Phase 2 — live tracking + Telegram

### Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your group (or DM it), send a message, then read the chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_CHAT_ID` (group ids are negative —
   keep it quoted). The bot only answers this chat.

### Webhook dev flow (ngrok)

```bash
ngrok http 3001                          # → https://xxxx.ngrok.app
# .env: PUBLIC_BASE_URL=https://xxxx.ngrok.app
#       WEBHOOK_AUTH_HEADER=<long random string>
pnpm dev:ingest
```

On boot (and whenever the watch list changes) ingest registers/updates **one** Helius enhanced
webhook (`SWAP` + `TRANSFER`) for every active `insider`/`watch`/`probation` wallet, pointing at
`${PUBLIC_BASE_URL}/webhook/helius`. Deliveries are authenticated by the `Authorization` header
matching `WEBHOOK_AUTH_HEADER`. To test the plumbing yourself: `/add <your-wallet>` in Telegram,
then make a small swap — the alert should arrive within seconds.

Alert format (Turkish, per design):

```
🚨 INSIDER BUY
Cüzdan: memelord (7xF4…k2Qp) — skor 84, 3x winner
Token: $WIF (EKpQ…BONK)
Miktar: 12.5 SOL | MC: $45.3K | Launch +4dk
Rotated wallet: hayır
Linkler: DexScreener | Solscan | GMGN
```

Sells use `📉 INSIDER SELL` (disable with `SELL_ALERTS=false`). Live MC resolution:
DexScreener → PumpPortal bonding-curve cache → derived from the swap itself — so alerts carry an
MC even before the token is listed anywhere.

### Bot commands

| Command | Effect |
|---|---|
| `/list` | Active insider/watch wallets with scores |
| `/add <addr> [label]` | Track a wallet (tier watch; never downgrades an existing tier) |
| `/mute <addr>` / `/unmute <addr>` | Suppress/enable its alerts (events still recorded) |
| `/stats <addr>` | Score breakdown, win rate, PnL, recent positions |
| `/tokens <mint>…` | Queue candidate tokens for the next analysis pass |
| `/scan` | Run the full pipeline now (same job the nightly cron runs) |
| `/health` | Component snapshot: DB/tier counts, Helius circuit, webhook, PumpPortal, queues |
| `/autobuy` | Auto-buy scoreboard (positions + X multiples); `on`/`off` toggles the kill switch |

### Rotation tracking

A watched wallet sending **≥ `TRANSFER_MIN_SOL`** (default 5) to an unknown, non-CEX address gets
that address tracked as `probation` (`parent_wallet` set), capped at `MAX_CHILDREN_PER_PARENT`
per source. A **delayed (~5 min) check** then applies the CEX-deposit heuristic — a fresh address
that forwarded ≥90% of received SOL to a known exchange is silently blacklisted; real targets are
registered with Helius and announced with `ℹ️ WALLET ROTATION`. The probation wallet's first buy
is alerted with `Rotated wallet: EVET (parent: …)`. Probation wallets that never trade expire
after `PROBATION_EXPIRY_DAYS` (default 14). Extend the exchange list in
`packages/shared/src/cex-wallets.ts`.

### Reliability

- **Idempotency**: `live_events (signature, wallet, event_type)` and
  `transfers (signature, from, to)` composite uniques — webhook retries and reconciliation
  replays are no-ops.
- **Reconciliation**: every `RECONCILE_INTERVAL_MIN` (default 5) each watched wallet's txs since
  its last processed signature are fetched and pushed through the same pipeline — missed webhook
  deliveries surface here. Events older than `ALERT_MAX_AGE_MIN` are recorded but never alerted.
- **Rate limits**: one Helius request queue (concurrency `HELIUS_CONCURRENCY`, exponential
  backoff on 429/5xx honoring Retry-After); Telegram alerts flow through a BullMQ worker limited
  to ~19 msg/min per chat.
- **Single instance**: ingest assumes one running process (in-memory watched-set cache,
  serialized webhook sync).

## Phase 3 — dashboard

```bash
pnpm dev:web        # http://localhost:3000   (production: pnpm build && pnpm --filter @insiderscope/web start)
```

- `/` — live 24h feed (5s incremental polling), active-wallet stats, most-bought tokens today,
  a **recent low-cap insider buys** board (watched wallets entering tokens still under the
  auto-buy cap, with entry → peak MC and the X multiple, refreshed every 10s, one-tap
  GMGN/Jupiter links), and a wallet **bubble map** (area ∝ |realized PnL|, color = tier, every
  bubble links to the wallet's profile; `/insiders` is its table twin)
- `/insiders` — sortable table (score, win rate, PnL, avg entry MC, trades, activity) with tier filter
- `/insiders/[address]` — "Who is this?" identity card (which runners it entered early and at
  what cap vs. the token's peak, whale-sized supply positions, creator links, rotation origin),
  score-component breakdown, entry-MC + timing histograms, positions
  table (entry MC, launch delta, supply %, exit MC, PnL, holding, creator-linked), funding &
  rotation tree, event timeline
- `/tokens/[mint]` — early-buyer ranking with insider flags and the creator connection map

Route handlers read Postgres directly through Drizzle — no separate API layer.

## Phase 4 (shipped: 4.1 + 4.2)

- **PumpPortal launch stream** — every new pump.fun token's curve state is cached in Redis
  (metadata + virtual reserves), so alerts show MC and "Launch +Xdk" before DexScreener lists the
  token. Mints that watched wallets buy get live trade subscriptions (LRU-capped). Disable with
  `PUMPPORTAL_ENABLED=false`.
- **🧨 Dev-launch alerts** — every pump.fun launch's creator is checked (5-min cache) against
  creators of past $10M tokens and all watched wallets; a hit alerts within seconds
  (`DEV_ALERTS=false` to disable).
- **🔥 Confluence alerts** — when `CONFLUENCE_MIN_WALLETS` (2) watched wallets buy the same mint
  within `CONFLUENCE_WINDOW_MIN` (60) minutes, a combined alert lists them by score — the
  strongest signal the system produces, deduped once per mint per window.
- **ATH flywheel (hourly)** — DexScreener-only refresh of every known token AND every mint bought
  by watched wallets in the last 7 days; a token crossing the discovery bar becomes a candidate
  and triggers the pipeline, whose early buyers become new insider candidates. Insiders lead to
  tokens, tokens lead to more insiders — unattended.
- **Recency priority** — the first focus is insiders of the **last 1-2 weeks**: a token that
  peaked ≥ `RECENT_MIN_MC_USD` ($5M) within `RECENT_WINDOW_DAYS` (14) qualifies for the pipeline
  and is crawled FIRST (newest peak first); older tokens still need `DISCOVER_MIN_MC_USD` ($10M)
  and are worked as the backlog, so when no fresh runner exists the old universe keeps growing.
- **Current-runner sweep** — GeckoTerminal's Solana trending + 24h-volume-leader pools (keyless,
  free, zero Helius credits) are swept at boot and every hour; pools clearing the pair-age-aware
  bar become candidates with a fresh peak timestamp, which lands them in the recency arm and gets
  them crawled on the next pass. This is what keeps the system pointed at what's running NOW.
- **Graduation funnel** — every pump.fun bonding-curve completion is recorded as a token row
  (`TRACK_GRADUATIONS`), the hourly refresh follows its MC, and the moment it clears the bar its
  bounded curve history is crawled — fresh runners feed the insider pool hours after launch.
  Dead graduates (< $1M after 14 days, no positions) are pruned automatically.
- **Honest crawls** — a token whose launch lies beyond `HELIUS_MAX_PAGES_TOKEN` pages (deep
  Raydium-native histories) is marked `skipped` instead of fabricating "early buyers" from a
  mid-history window; previously mislabeled tokens are repaired and re-crawled automatically.
- **Watch floor** — when fewer than `WATCH_FLOOR` (12) wallets clear the score thresholds, the
  best-scoring unranked wallets (with a genuine early position on a curve-crawled token) are
  promoted to `watch`, so the live system always has subjects to alert on.
- **Self-driving ops** — boot health report to Telegram, auto-scan when there's pending work, a
  15-min watchdog that alerts once on each problem (and once on recovery) and re-registers the
  Helius webhook if it drifts, credit/circuit awareness (a dead Helius key pauses crawling and
  reports instead of burning retries), and pipeline start/finish/abort notices. The watch floor
  also runs directly at boot (pure SQL) — a redeploy never sits with an empty watch list waiting
  for the next scoring pass to reach its final step.
- **📊 Daily digest** — 09:00 UTC summary (24h events, top buys, tier counts);
  `DIGEST_ENABLED=false` to disable.
- **Unattended pipeline** — 03:00 UTC nightly (and on demand via the bot's `/scan`), the ingest
  service runs the whole historical pipeline in-process: import CSVs from `TOKENS_DIR` →
  `discover` → `early-buyers --all` → `funding --all` → `score`, then refreshes the Helius
  webhook address list. Each stage is isolated, so a failing stage doesn't abort the rest, and
  every command is idempotent, so the next pass resumes cleanly. Running the analyzer CLI by hand
  is therefore optional — useful for a first backfill or a single token, not required for
  steady-state operation. The pipeline has its own BullMQ queue so a multi-hour pass never
  delays reconciliation or rotation checks.

  **Curated token lists**: the repo ships a seed list of well-known $10M+ memecoins
  (`fixtures/tokens.seed.csv`). On the first pass it is planted into `TOKENS_DIR` (default
  `/data/tokens` — mount a persistent volume there) as `seed.csv` and re-imported on every pass,
  so a fresh deployment analyzes real candidates with zero manual steps. Drop your own
  `*.csv` files (`mint[,symbol[,ath_mc_usd[,name]]]`) next to it to extend the universe; edits
  to `seed.csv` persist (comment lines out with `#` to disable tokens), deleting it restores the
  defaults, and without a volume the bundled seed is imported directly.

### Auto-buy (paper-first)

When a watched insider/watch wallet buys a **fresh mint** (launched < `AUTOBUY_MAX_MINT_AGE_MIN`
minutes ago, or still under `AUTOBUY_MAX_MC_USD`), the executor opens a position — this is the
"they just launched it, run" moment, automated. It ships in **dry-run**: no real money moves;
every signal records a simulated `AUTOBUY_SOL_PER_TRADE` buy in `paper_trades`, the token's
market cap is tracked live (event stream + hourly refresh), and milestone messages report
**how many X** the entry did (2x/5x/10x/...; MC multiple = price multiple at fixed supply).
Positions stop tracking after 14 days — the recorded peak is the verdict. `/autobuy` shows the
scoreboard; `/autobuy off|on` is the kill switch.

Guardrails (enforced identically in dry-run and live): one position per mint ever, daily SOL
ceiling (`AUTOBUY_DAILY_CAP_SOL`), tier filter (`AUTOBUY_TIERS`), stale/backfilled events never
trigger, muted wallets never trigger.

**Going live** (only after the dry-run scoreboard convinces you): create a **separate burner
wallet**, fund it with a small amount, set `AUTOBUY_WALLET_SECRET` (bs58) and
`AUTOBUY_DRY_RUN=false`. Execution is self-custody: PumpPortal's `trade-local` builds the
transaction, it is signed locally with your key and sent through Helius RPC — the key never
leaves your server. Selling stays manual (GMGN/Jupiter links in every alert); automated
take-profit is a future iteration informed by the paper data. Never use your main wallet.

Not implemented (by design, next iterations): fake-wallet/exit-liquidity ("baiter") detection and
automated selling / take-profit.

## Configuration

Required: `HELIUS_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `WEBHOOK_AUTH_HEADER`, `PUBLIC_BASE_URL`, `INGEST_PORT`.

Recommended: `WEB_BASE_URL` — the dashboard's public URL (on the ingest service). When set,
every Telegram alert deep-links the wallet name to its `/insiders/<address>` profile, and swap
alerts carry a one-line pedigree ("Geçmişi: $WIF giriş $61K → tepe $3.2B") built from the
wallet's best $10M+ positions.

Tunables (defaults in parentheses): `EARLY_WINDOW_MIN` (30), `EARLY_MAX_BUYERS` (150),
`TRANSFER_MIN_SOL` (5), `SELL_ALERTS` (true), `PROBATION_EXPIRY_DAYS` (14),
`MAX_CHILDREN_PER_PARENT` (3), `MIN_SCORED_POSITIONS` (3), `ALERT_DEBOUNCE_SEC` (10),
`ALERT_MAX_AGE_MIN` (15), `RECONCILE_INTERVAL_MIN` (5), `HELIUS_CONCURRENCY` (5),
`HELIUS_RPS` (10), `HELIUS_MAX_PAGES_TOKEN` (300), `HELIUS_MAX_PAGES_WALLET` (20),
`FUNDING_MAX_PAGES` (8), `FUNDING_MAX_FUNDERS` (10), `FUNDING_LOOKBACK_DAYS` (30),
`TOKENS_DIR` (/data/tokens), `SCORE_MAX_TRADES` (500), `SCORE_SELECTIVITY_TRADES` (200),
`SCORE_REFRESH_DAYS` (3), `CONFLUENCE_MIN_WALLETS` (2), `CONFLUENCE_WINDOW_MIN` (60),
`DEV_ALERTS` (true), `DIGEST_ENABLED` (true), `WATCH_FLOOR` (12), `TRACK_GRADUATIONS` (true),
`PUMPPORTAL_ENABLED` (true), `DISCOVER_MIN_MC_USD` (10000000), `RECENT_MIN_MC_USD` (5000000),
`RECENT_WINDOW_DAYS` (14), `MIGRATE_ON_BOOT` (true), `SOL_PRICE_FALLBACK_USD` (unset).

## Deploy to Railway

The repo ships config-as-code for two Railway services sharing this repo, plus Railway's Postgres
and Redis. Migrations run automatically when ingest boots (`MIGRATE_ON_BOOT=true` default), and
`PUBLIC_BASE_URL` auto-derives from the service's Railway domain — no ngrok in production.

1. **Create a project** and add **PostgreSQL** and **Redis** (`New → Database`). Note their
   service names (usually `Postgres` and `Redis`).
2. **Ingest service** — `New → GitHub Repo` (this repo). In *Settings → Config-as-code* set the
   config file path to `apps/ingest/railway.json` and **redeploy** (keep Root Directory at the
   repo root — the pnpm lockfile lives there). This step is not optional: without it the builder
   has no start command for a workspace root and the build fails with
   `No start command detected`. If the config file is not picked up for any reason, the
   equivalent manual settings are *Settings → Deploy → Custom Start Command*
   `pnpm --filter @insiderscope/ingest start` and *Settings → Build → Custom Build Command*
   `pnpm install --frozen-lockfile`. Variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `HELIUS_API_KEY` | your key |
   | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | from BotFather / getUpdates |
   | `WEBHOOK_AUTH_HEADER` | a long random string |

   Don't set `INGEST_PORT` or `PUBLIC_BASE_URL`: the app listens on Railway's injected `PORT`,
   and once you hit *Settings → Networking → Generate Domain*, the webhook base URL is derived
   from `RAILWAY_PUBLIC_DOMAIN` automatically. Keep this service at **1 replica**.
3. **Web service** — add a second service from the same repo, config file path
   `apps/web/railway.json` (manual equivalent: build `pnpm --filter @insiderscope/web build`,
   start `pnpm --filter @insiderscope/web start`). Variables: only
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`. Generate a domain for it — that's your dashboard
   URL.

   The config files leave the builder unset so Railway's current default (Railpack) is used —
   it detects the pnpm workspace and installs the pinned pnpm via Corepack on its own.
4. **Analyzer one-offs** — open a shell into the ingest service (`railway ssh`, or the service's
   Console tab) and run the pipeline there:
   `pnpm analyzer import-tokens fixtures/tokens.sample.csv && pnpm analyzer early-buyers --all && pnpm analyzer funding --all && pnpm analyzer score`.
   (Running from your laptop also works if you point `DATABASE_URL` at the database's **public**
   connection string — append `?sslmode=require` to it; the `${{…}}` references above resolve to
   internal `railway.internal` hosts, which are only reachable between services.)

The reference-variable syntax `${{Postgres.DATABASE_URL}}` must match your database service's
name — if Railway named it differently, pick the variable through the autocomplete in the
Variables editor.

## Development

```bash
pnpm test          # vitest across all packages (fixture-driven; DB suites skip without DATABASE_URL)
pnpm typecheck     # strict tsc across the workspace
pnpm build         # next build
pnpm db:generate   # regenerate SQL after editing packages/db/src/schema (commit the output)
```

Realistic Helius/PumpPortal/DexScreener payload fixtures live in `fixtures/` — the swap
normalizer, launch detection, classifier, scorer, funding BFS and the idempotent pipeline are all
unit-tested against them; DB-touching suites run against a real Postgres.

## Known limitations (deliberate MVP trade-offs)

- `discover` is best-effort: there is no public "all pairs ≥ $10M ATH" endpoint, so ATH values
  are max-observed (or CSV-provided) and the CSV import is the primary seeding path.
- Post-graduation sell PnL is completed at `score` time (full wallet history), not during the
  bonding-curve crawl; unrealized PnL is not included in totals (`still_holding` flags it).
- The funding graph is bounded: last 90 days, top `FUNDING_MAX_FUNDERS` second-hop funders.
- Rotation alerts are intentionally ~5 minutes delayed by the CEX-deposit check; buy alerts stay
  real-time.
- Helius enhanced-parse shapes vary in the wild (pump.fun swaps often lack `events.swap`); all
  shape assumptions are isolated in `packages/shared/src/helius/normalize.ts` — expect to tune
  there first if a payload class goes unrecognized.

> Research tooling only — nothing here is financial advice.
