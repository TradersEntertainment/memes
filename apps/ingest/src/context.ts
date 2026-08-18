import { getDb, type Db } from '@insiderscope/db';
import { getConfig, HeliusClient, type AppConfig } from '@insiderscope/shared';
import type { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Bot } from 'grammy';
import { createAlertsQueue } from './alerts/queue';
import { createBot } from './bot/bot';
import { makeResolveMc } from './pipeline/enrich';
import { handleTransferOut, type RotationDeps } from './pipeline/rotation';
import type { PipelineDeps } from './pipeline/process';
import { PumpCurveCache } from './pump-cache';
import { PumpPortalConsumer } from './pumpportal';
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
    ? new HeliusClient({ apiKey: cfg.HELIUS_API_KEY, concurrency: cfg.HELIUS_CONCURRENCY, log })
    : null;
  if (!helius) log('HELIUS_API_KEY not set — webhook registration and reconciliation disabled');

  const pumpCache = new PumpCurveCache(redis);
  const pumpPortal = cfg.PUMPPORTAL_ENABLED ? new PumpPortalConsumer({ pumpCache, log }) : null;
  const alertsQueue = createAlertsQueue(cfg.REDIS_URL);
  const systemQueue = createSystemQueue(cfg.REDIS_URL);
  const pipelineQueue = createPipelineQueue(cfg.REDIS_URL);

  const rotationDeps: RotationDeps = {
    db,
    cfg,
    log,
    scheduleRotationCheck: async (data, delayMs) => {
      await systemQueue.add('rotation-check', data, { delay: delayMs });
    },
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
