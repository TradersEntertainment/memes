import { closeDb } from '@insiderscope/db';
import { runMigrations } from '@insiderscope/db/migrate';
import { getConfig, resolveIngestPort } from '@insiderscope/shared';
import { startAlertWorker } from './alerts/queue';
import { buildAppCtx } from './context';
import { buildHealthReport } from './health';
import { maybeAutoScan } from './jobs/nightly-rescore';
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

  // Self-starting analysis + boot report: check for pending work, queue a pass if
  // needed, then tell Telegram what state every component came up in — so a
  // redeploy confirms itself instead of someone tailing logs.
  void (async () => {
    const queued = await maybeAutoScan(ctx, 'boot').catch((err) => {
      ctx.log(`boot auto-scan failed: ${err}`);
      return false;
    });
    const report = await buildHealthReport(ctx).catch(() => null);
    const text = [
      '🟢 <b>Sistem açıldı</b>',
      ...(report?.lines ?? []),
      queued
        ? '🔍 Bekleyen iş bulundu — analiz turu otomatik başlatıldı.'
        : '🔍 Bekleyen analiz işi yok — saatlik eşik kontrolü ve gece turu devrede.',
    ].join('\n');
    await ctx.alertsQueue.add('custom', { custom: { text } });
  })().catch((err) => ctx.log(`boot notice failed: ${err}`));

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
