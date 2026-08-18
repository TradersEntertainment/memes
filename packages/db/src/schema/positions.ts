import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { wallets } from './wallets';

/**
 * One row per wallet x token. Created either by early-buyer extraction (full detail)
 * or as a skeleton from the wallet's complete swap history (survivorship-bias
 * countermeasure — losers count too). `mint` is intentionally NOT a foreign key:
 * skeleton positions reference tokens we never imported.
 */
export const positions = pgTable(
  'positions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet')
      .notNull()
      .references(() => wallets.address),
    mint: text('mint').notNull(),
    firstBuyTs: timestamp('first_buy_ts', { withTimezone: true, mode: 'date' }),
    firstBuySlot: bigint('first_buy_slot', { mode: 'number' }),
    // null for skeleton positions (token never crawled, launch moment unknown)
    secondsAfterLaunch: doublePrecision('seconds_after_launch'),
    entryMcUsd: doublePrecision('entry_mc_usd'),
    entryAmountSol: doublePrecision('entry_amount_sol'),
    tokenAmount: doublePrecision('token_amount'),
    pctOfSupply: doublePrecision('pct_of_supply'),
    // token-amount-weighted average market cap across sells
    exitMcUsd: doublePrecision('exit_mc_usd'),
    realizedPnlUsd: doublePrecision('realized_pnl_usd'),
    stillHolding: boolean('still_holding'),
    creatorLinked: boolean('creator_linked').notNull().default(false),
  },
  (t) => [
    uniqueIndex('positions_wallet_mint_uq').on(t.wallet, t.mint),
    index('positions_wallet_idx').on(t.wallet),
    index('positions_mint_idx').on(t.mint),
  ],
);

export type PositionRow = typeof positions.$inferSelect;
export type NewPositionRow = typeof positions.$inferInsert;
