import { Worker } from 'bullmq';
import { makeBullConnection } from '../alerts/queue';
import type { AppCtx } from '../context';
import type { RotationCheckJobData } from '../pipeline/rotation';
import { SYSTEM_QUEUE } from '../system-queue';
import { nightlyRescore } from './nightly-rescore';
import { sweepProbation } from './probation-expiry';
import { reconcile } from './reconcile';
import { runRotationCheck } from './rotation-check';

export function startSystemWorker(ctx: AppCtx): Worker {
  const worker = new Worker(
    SYSTEM_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'reconcile':
          await reconcile(ctx);
          break;
        case 'probation-expiry':
          await sweepProbation(ctx);
          break;
        case 'rotation-check':
          await runRotationCheck(ctx, job.data as RotationCheckJobData);
          break;
        case 'nightly-rescore':
          await nightlyRescore(ctx);
          break;
        default:
          ctx.log(`system worker: unknown job "${job.name}"`);
      }
    },
    { connection: makeBullConnection(ctx.cfg.REDIS_URL), concurrency: 1 },
  );
  worker.on('failed', (job, err) => ctx.log(`system job ${job?.name} failed: ${err.message}`));
  return worker;
}

/** upsertJobScheduler is restart-safe — schedules never stack duplicates. */
export async function scheduleRepeatables(ctx: AppCtx): Promise<void> {
  await ctx.systemQueue.upsertJobScheduler(
    'reconcile',
    { every: ctx.cfg.RECONCILE_INTERVAL_MIN * 60_000 },
    { name: 'reconcile' },
  );
  await ctx.systemQueue.upsertJobScheduler(
    'probation-expiry',
    { every: 3_600_000 },
    { name: 'probation-expiry' },
  );
  await ctx.systemQueue.upsertJobScheduler(
    'nightly-rescore',
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: 'nightly-rescore' },
  );
  ctx.log('system jobs scheduled: reconcile, probation-expiry, nightly-rescore');
}
