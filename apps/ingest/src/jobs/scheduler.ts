import { Worker } from 'bullmq';
import { makeBullConnection } from '../alerts/queue';
import type { AppCtx } from '../context';
import type { RotationCheckJobData } from '../pipeline/rotation';
import { PIPELINE_QUEUE, SYSTEM_QUEUE } from '../system-queue';
import { nightlyRescore, type PipelineReason } from './nightly-rescore';
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
        default:
          ctx.log(`system worker: unknown job "${job.name}"`);
      }
    },
    { connection: makeBullConnection(ctx.cfg.REDIS_URL), concurrency: 1 },
  );
  worker.on('failed', (job, err) => ctx.log(`system job ${job?.name} failed: ${err.message}`));
  return worker;
}

/** Separate worker so a multi-hour analysis pass never blocks the short jobs. */
export function startPipelineWorker(ctx: AppCtx): Worker {
  const worker = new Worker(
    PIPELINE_QUEUE,
    async (job) => {
      await nightlyRescore(ctx, (job.data as { reason?: PipelineReason })?.reason ?? 'nightly');
    },
    { connection: makeBullConnection(ctx.cfg.REDIS_URL), concurrency: 1 },
  );
  worker.on('failed', (job, err) => ctx.log(`pipeline job ${job?.id} failed: ${err.message}`));
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
  await ctx.pipelineQueue.upsertJobScheduler(
    'nightly-pipeline',
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: 'pipeline', data: { reason: 'nightly' } },
  );
  // Drop the pre-split schedule so upgraded deployments don't keep running the
  // pipeline on the latency-sensitive queue.
  await ctx.systemQueue.removeJobScheduler('nightly-rescore').catch(() => undefined);
  ctx.log(
    'jobs scheduled: reconcile (5m), probation-expiry (1h), full pipeline (03:00 UTC, own queue)',
  );
}
