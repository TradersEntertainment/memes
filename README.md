# InsiderScope

Solana memecoin insider tracker: finds the real insiders (not sniper bots) of tokens that reached
$10M+ market cap from historical on-chain data, watches those wallets live via Helius webhooks,
sends Telegram alerts within seconds when they buy, auto-follows wallet rotations, and shows each
insider's profile on a dashboard.

> Full setup docs, CLI examples and the ngrok webhook flow are documented below (work in progress
> while the project is being built phase by phase).

## Stack

- **apps/analyzer** — batch/analysis CLIs (token discovery, early-buyer extraction, funding graph, scoring)
- **apps/ingest** — Fastify Helius webhook + Telegram bot (grammY) + BullMQ jobs + PumpPortal stream
- **apps/web** — Next.js 14 dashboard (dark terminal aesthetic)
- **packages/db** — Drizzle ORM schema + Postgres client
- **packages/shared** — domain library: Helius client, swap normalization, launch detection, MC derivation, scorer, funding graph

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in HELIUS_API_KEY etc.
docker compose up -d        # postgres:16 + redis:7
pnpm db:migrate
pnpm test
```
