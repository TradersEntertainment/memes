import { pgEnum } from 'drizzle-orm/pg-core';

export const launchPlatformEnum = pgEnum('launch_platform', ['pumpfun', 'raydium', 'other']);

export const tokenStatusEnum = pgEnum('token_status', ['candidate', 'analyzed', 'skipped']);

export const walletTierEnum = pgEnum('wallet_tier', ['insider', 'watch', 'probation', 'blacklist']);

export const liveEventTypeEnum = pgEnum('live_event_type', [
  'buy',
  'sell',
  'transfer_out',
  'transfer_in',
]);
