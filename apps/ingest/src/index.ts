import { closeDb } from '@insiderscope/db';
import { runMigrations } from '@insiderscope/db/migrate';
import { getConfig, resolveIngestPort } from '@insiderscope/shared';
import { startAlertWorker } from './alerts/queue';
import { buildAppCtx } from './context';
import { scheduleRepeatables, startPipelineWorker, startSystemWorker } from './jobs/scheduler';
import { buildServer } from './server';
import { syncHeliusWebhook } from './webhook-sync';

async function main(): Promise<void> {
  const cfg = getConfig();
  if (cfg.MIGRATE_ON_BOOT) {
    await runMigrations(cfg.DATABASE_URL);
    console.log('[ingest] database migrations applied');
  }

  const ctx = buildAppCtx();
  const workers = [
    startAlertWorker(ctx, ctx.cfg.REDIS_URL),
    startSystemWorker(ctx),
    startPipelineWorker(ctx),
  ];
  await scheduleRepeatables(ctx);

  const port = resolveIngestPort(ctx.cfg);
  const app = buildServer(ctx);
  await app.listen({ port, host: '0.0.0.0' });
  ctx.log(`webhook server listening on :${port}`);

  if (ctx.bot) {
    void ctx.bot
      .start({ drop_pending_updates: true })
      .catch((err) => ctx.log(`bot polling stopped: ${err}`));
    ctx.log('telegram bot polling started');
  }

  await syncHeliusWebhook(ctx).catch((err) => ctx.log(`initial webhook sync failed: ${err}`));

  ctx.pumpPortal?.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log(`${signal} — shutting down`);
    ctx.pumpPortal?.stop();
    await app.close().catch(() => {});
    await ctx.bot?.stop().catch(() => {});
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([
      ctx.alertsQueue.close(),
      ctx.systemQueue.close(),
      ctx.pipelineQueue.close(),
    ]);
    ctx.redis.disconnect();
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
