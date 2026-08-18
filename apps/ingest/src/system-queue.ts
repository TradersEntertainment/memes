import { Queue } from 'bullmq';
import { makeBullConnection } from './alerts/queue';

/** Repeatable jobs + delayed one-offs (rotation-check) share one queue. */
export const SYSTEM_QUEUE = 'insiderscope-system';

export function createSystemQueue(redisUrl: string): Queue {
  return new Queue(SYSTEM_QUEUE, {
    connection: makeBullConnection(redisUrl),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  });
}
