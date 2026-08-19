import { getDb, tokens, type Db } from '@insiderscope/db';
import {
  deriveBondingCurvePda,
  escapeHtml,
  fmtUsdCompact,
  getConfig,
  getSolPriceUsdNow,
  HeliusClient,
  pumpfunMcSol,
  shortAddr,
  type AppConfig,
} from '@insiderscope/shared';
import type { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Bot } from 'grammy';
import { createAlertsQueue } from './alerts/queue';
import { maybeAutoBuy, type AutoBuyDeps } from './autobuy/executor';
import { updatePaperMc } from './autobuy/tracker';
import { createBot } from './bot/bot';
import { makeResolveMc } from './pipeline/enrich';
import { handleTransferOut, type RotationDeps } from './pipeline/rotation';
import type { PipelineDeps } from './pipeline/process';
import { lookupKnownCreator } from './creator-watch';
import { PumpCurveCache } from './pump-cache';
import { PumpPortalConsumer, type PumpPortalCtx } from './pumpportal';
import { createPipelineQueue, createSystemQueue } from './system-queue';
import { getWatchedWallets } from './watched';

export interface AppCtx {
  db: Db;
  cfg: AppConfig;
  log: (msg: string) => void;
  redis: IORedis;
  helius: HeliusClient | null;
  bot: Bot | null;
  pumpCache: PumpCurveCache;
  pumpPortal: PumpPortalConsumer | null;
  alertsQueue: Queue;
  systemQueue: Queue;
  pipelineQueue: Queue;
  pipeline: PipelineDeps;
}

export function buildAppCtx(): AppCtx {
  const cfg = getConfig();
  const db = getDb();
  const log = (msg: string) => console.log(`[ingest] ${msg}`);

  const redis = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const helius = cfg.HELIUS_API_KEY
    ? new HeliusClient({
        apiKey: cfg.HELIUS_API_KEY,
        concurrency: cfg.HELIUS_CONCURRENCY,
        requestsPerSecond: cfg.HELIUS_RPS,
        log,
      })
    : null;
  if (!helius) log('HELIUS_API_KEY not set — webhook registration and reconciliation disabled');

  const pumpCache = new PumpCurveCache(redis);
  const pumpPortalCtx: PumpPortalCtx = { pumpCache, log };
  const pumpPortal = cfg.PUMPPORTAL_ENABLED ? new PumpPortalConsumer(pumpPortalCtx) : null;
  const alertsQueue = createAlertsQueue(cfg.REDIS_URL);
  const systemQueue = createSystemQueue(cfg.REDIS_URL);
  const pipelineQueue = createPipelineQueue(cfg.REDIS_URL);

  const enqueueCustomAlert = async (text: string) => {
    await alertsQueue.add('custom', { custom: { text } });
  };

  // Graduation tracking — the "fresh runner" funnel: a bonding-curve completion
  // becomes a tokens row at its graduation MC (~$70K). The hourly ATH refresh
  // then follows its market cap; once it crosses the discovery bar ($5M inside
  // the recency window, $10M otherwise) it turns into a real candidate, its
  // (bounded) curve history is crawled, and its early buyers enter the insider
  // pool — all unattended, hours after the run starts.
  pumpPortalCtx.onMigration = (mint) => {
    if (!cfg.TRACK_GRADUATIONS) return;
    void (async () => {
      const cached = await pumpCache.get(mint);
      const solUsd = await getSolPriceUsdNow({ fallbackUsd: cfg.SOL_PRICE_FALLBACK_USD });
      const gradMc =
        cached && cached.vTokens > 0 && solUsd != null
          ? pumpfunMcSol(cached.vSol, cached.vTokens) * solUsd
          : 70_000; // typical graduation cap — placeholder until the hourly refresh
      await db
        .insert(tokens)
        .values({
          mint,
          symbol: cached?.symbol ?? null,
          name: cached?.name ?? null,
          creatorWallet: cached?.creator ?? null,
          launchPlatform: 'pumpfun',
          launchTs: cached?.launchTs ?? null,
          bondingCurve: deriveBondingCurvePda(mint),
          athMcUsd: gradMc,
          athTs: new Date(),
          status: 'candidate',
        })
        .onConflictDoNothing();
    })().catch((err) => log(`graduation track failed for ${mint}: ${err}`));
  };

  // Dev-launch watch: every pump.fun launch's creator is checked against known
  // $10M-token creators and watched wallets — a hit alerts within seconds.
  pumpPortalCtx.onNewToken = (info) => {
    if (!cfg.DEV_ALERTS) return;
    void (async () => {
      const hit = await lookupKnownCreator(db, cfg.DISCOVER_MIN_MC_USD, info.creator);
      if (!hit) return;
      const dedupeKey = `is:devlaunch:${info.creator}`;
      if ((await redis.set(dedupeKey, '1', 'EX', 3600, 'NX')) !== 'OK') return;
      pumpPortal?.trackMint(info.mint);
      const who =
        hit.kind === 'creator'
          ? `geçmişi: ${hit.pastSymbol ? `$${escapeHtml(hit.pastSymbol)}` : 'bilinen token'}${
              hit.pastAthUsd ? ` (${fmtUsdCompact(hit.pastAthUsd)} ATH)` : ''
            } creator'ı`
          : `izlenen cüzdan (${hit.tier}${hit.score != null ? `, skor ${Math.round(hit.score)}` : ''})`;
      const text = [
        `🧨 <b>BİLİNEN CÜZDAN YENİ TOKEN ÇIKARDI</b>`,
        `Creator: ${hit.label ? escapeHtml(hit.label) : shortAddr(info.creator!)} — ${who}`,
        `Token: ${info.symbol ? `$${escapeHtml(info.symbol)}` : shortAddr(info.mint)} (${shortAddr(info.mint)})`,
        `Linkler: <a href="https://pump.fun/${info.mint}">pump.fun</a> | <a href="https://gmgn.ai/sol/token/${info.mint}">GMGN</a>`,
      ].join('\n');
      await enqueueCustomAlert(text);
      log(`dev-launch alert: ${info.creator} → ${info.mint}`);
    })().catch((err) => log(`dev-launch check failed: ${err}`));
  };

  const rotationDeps: RotationDeps = {
    db,
    cfg,
    log,
    scheduleRotationCheck: async (data, delayMs) => {
      await systemQueue.add('rotation-check', data, { delay: delayMs });
    },
  };

  // Auto-buy (dry-run first): the pipeline hands every fresh insider buy to the
  // executor; the executor's guardrails decide, and paper positions get their
  // MC refreshed by the same event stream.
  const autoBuyDeps: AutoBuyDeps = {
    db,
    cfg,
    log,
    pumpCache,
    helius,
    isPaused: async () => (await redis.get('is:autobuy:paused')) === '1',
    notify: enqueueCustomAlert,
    trackMint: (mint) => pumpPortal?.trackMint(mint),
  };

  const pipeline: PipelineDeps = {
    db,
    cfg,
    log,
    getWatched: () => getWatchedWallets(db),
    debounce: async (key, ttlSec) =>
      (await redis.set(key, '1', 'EX', Math.max(1, Math.ceil(ttlSec)), 'NX')) === 'OK',
    enqueueAlert: async (eventId) => {
      await alertsQueue.add('alert', { eventId });
    },
    resolveMc: makeResolveMc({ db, cfg, helius, pumpCache, log }),
    onTransferOut: (input) => handleTransferOut(rotationDeps, input),
    trackMint: (mint) => pumpPortal?.trackMint(mint),
    enqueueCustomAlert,
    onInsiderBuy: async (signal) => {
      await maybeAutoBuy(autoBuyDeps, signal);
    },
    updatePaperMc: async (mint, mcUsd) => {
      const milestone = await updatePaperMc(db, mint, mcUsd);
      if (milestone) await enqueueCustomAlert(milestone);
    },
  };

  const ctx: AppCtx = {
    db,
    cfg,
    log,
    redis,
    helius,
    bot: null,
    pumpCache,
    pumpPortal,
    alertsQueue,
    systemQueue,
    pipelineQueue,
    pipeline,
  };
  ctx.bot = createBot(ctx);
  return ctx;
}
