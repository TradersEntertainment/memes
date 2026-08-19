import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Auto-buy positions — paper (dry-run) by default, real once live mode is on.
 * One row per mint (the unique doubles as the "never buy the same mint twice"
 * guard). "How many X did it do" = peak_mc_usd / entry_mc_usd: with memecoin
 * supply fixed, the market-cap multiple is the price multiple.
 */
export const paperTrades = pgTable(
  'paper_trades',
  {
    id: serial('id').primaryKey(),
    mint: text('mint').notNull().unique(),
    /** Watched wallet whose buy triggered this position. */
    wallet: text('wallet'),
    signal: text('signal').notNull().default('insider-buy'),
    isLive: boolean('is_live').notNull().default(false),
    solSpent: doublePrecision('sol_spent').notNull(),
    entryMcUsd: doublePrecision('entry_mc_usd'),
    entryTs: timestamp('entry_ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    peakMcUsd: doublePrecision('peak_mc_usd'),
    peakTs: timestamp('peak_ts', { withTimezone: true, mode: 'date' }),
    /** Lowest MC seen since entry — with peak it is the position's permanent verdict. */
    troughMcUsd: doublePrecision('trough_mc_usd'),
    troughTs: timestamp('trough_ts', { withTimezone: true, mode: 'date' }),
    lastMcUsd: doublePrecision('last_mc_usd'),
    lastCheckTs: timestamp('last_check_ts', { withTimezone: true, mode: 'date' }),
    /** Highest multiple already announced (2/5/10/25...) so milestones fire once. */
    milestoneNotified: doublePrecision('milestone_notified').notNull().default(1),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    /** Real transaction signature when is_live. */
    txSignature: text('tx_signature'),
  },
  (t) => [index('paper_trades_status_idx').on(t.status)],
);

export type PaperTradeRow = typeof paperTrades.$inferSelect;
export type NewPaperTradeRow = typeof paperTrades.$inferInsert;
