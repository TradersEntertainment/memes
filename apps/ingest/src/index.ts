import { closeDb } from '@insiderscope/db';
import { startAlertWorker } from './alerts/queue';
import { buildAppCtx } from './context';
import { scheduleRepeatables, startSystemWorker } from './jobs/scheduler';
import { buildServer } from './server';
import { syncHeliusWebhook } from './webhook-sync';

async function main(): Promise<void> {
  const ctx = buildAppCtx();
  const workers = [startAlertWorker(ctx, ctx.cfg.REDIS_URL), startSystemWorker(ctx)];
  await scheduleRepeatables(ctx);

  const app = buildServer(ctx);
  await app.listen({ port: ctx.cfg.INGEST_PORT, host: '0.0.0.0' });
  ctx.log(`webhook server listening on :${ctx.cfg.INGEST_PORT}`);

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
    await Promise.allSettled([ctx.alertsQueue.close(), ctx.systemQueue.close()]);
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
