import { Queue } from 'bullmq';
import { makeBullConnection } from './alerts/queue';

/** Short, latency-sensitive jobs: reconcile, probation expiry, rotation checks. */
export const SYSTEM_QUEUE = 'insiderscope-system';

/**
 * The historical pipeline lives on its own queue: a full analysis pass can run
 * for hours, and on a shared single-worker queue it would starve reconcile and
 * rotation-check — a missed webhook event ages past the alert window and is then
 * recorded but never alerted.
 */
export const PIPELINE_QUEUE = 'insiderscope-pipeline';

function queueOptions(redisUrl: string, attempts: number) {
  return {
    connection: makeBullConnection(redisUrl),
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential' as const, delay: 10_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  };
}

export function createSystemQueue(redisUrl: string): Queue {
  return new Queue(SYSTEM_QUEUE, queueOptions(redisUrl, 2));
}

export function createPipelineQueue(redisUrl: string): Queue {
  // No retries: a half-finished pass is resumed by the next run anyway, and a
  // retry would re-spend Helius credits on work that already succeeded.
  return new Queue(PIPELINE_QUEUE, queueOptions(redisUrl, 1));
}
