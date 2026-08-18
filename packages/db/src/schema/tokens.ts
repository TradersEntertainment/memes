import { bigint, doublePrecision, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { launchPlatformEnum, tokenStatusEnum } from './enums';

export const tokens = pgTable('tokens', {
  mint: text('mint').primaryKey(),
  symbol: text('symbol'),
  name: text('name'),
  creatorWallet: text('creator_wallet'),
  launchPlatform: launchPlatformEnum('launch_platform'),
  launchTs: timestamp('launch_ts', { withTimezone: true, mode: 'date' }),
  launchSlot: bigint('launch_slot', { mode: 'number' }),
  // pump.fun bonding curve PDA — the address whose bounded history contains every early buy
  bondingCurve: text('bonding_curve'),
  // AMM pool address (from the DexScreener pair) for Raydium-native tokens
  poolAddress: text('pool_address'),
  athMcUsd: doublePrecision('ath_mc_usd'),
  athTs: timestamp('ath_ts', { withTimezone: true, mode: 'date' }),
  status: tokenStatusEnum('status').notNull().default('candidate'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type TokenRow = typeof tokens.$inferSelect;
export type NewTokenRow = typeof tokens.$inferInsert;
