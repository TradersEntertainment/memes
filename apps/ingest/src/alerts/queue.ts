import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import type { SendCtx } from './send';
import { sendSwapAlert } from './send';

export const ALERTS_QUEUE = 'insiderscope-alerts';

export function makeBullConnection(redisUrl: string): IORedis {
  // BullMQ requirement: blocking commands need maxRetriesPerRequest: null,
  // otherwise workers crash on boot.
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

export function createAlertsQueue(redisUrl: string): Queue {
  return new Queue(ALERTS_QUEUE, {
    connection: makeBullConnection(redisUrl),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  });
}

export interface AlertJobData {
  eventId: number;
}

/**
 * One worker, one message at a time, ~19 msg/min — inside Telegram's 20/min
 * per-chat limit; bursts queue up instead of getting 429s.
 */
export function startAlertWorker(ctx: SendCtx, redisUrl: string): Worker<AlertJobData> {
  const worker = new Worker<AlertJobData>(
    ALERTS_QUEUE,
    async (job) => {
      await sendSwapAlert(ctx, job.data.eventId);
    },
    {
      connection: makeBullConnection(redisUrl),
      concurrency: 1,
      limiter: { max: 19, duration: 60_000 },
    },
  );
  worker.on('failed', (job, err) => {
    ctx.log(`alert job ${job?.id} failed: ${err.message}`);
  });
  return worker;
}
