import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { walletTierEnum } from './enums';

/** Persisted scoring detail — rendered by the dashboard without recomputing. */
export interface ScoreBreakdownJson {
  /** Weighted points per component (sums to the 0-100 score). */
  points: {
    repeat: number;
    creatorLink: number;
    winRate: number;
    selectivity: number;
    timing: number;
  };
  /** Raw 0-1 factors before weighting. */
  factors: {
    repeatFactor: number;
    creatorLinkFactor: number;
    winRate: number;
    selectivityFactor: number;
    timingFactor: number;
  };
  medianEntrySeconds: number | null;
  bigTokenCount: number;
  decidedPositions: number;
  earlyPositions: number;
  blacklistReason?: string;
  computedAt: string;
}

export const wallets = pgTable('wallets', {
  address: text('address').primaryKey(),
  label: text('label'),
  // null = unscored candidate (row created by early-buyer extraction, not yet scored)
  tier: walletTierEnum('tier'),
  insiderScore: doublePrecision('insider_score'),
  winRate: doublePrecision('win_rate'),
  totalTrades: integer('total_trades'),
  totalPnlUsd: doublePrecision('total_pnl_usd'),
  avgEntryMc: doublePrecision('avg_entry_mc'),
  scoreBreakdown: jsonb('score_breakdown').$type<ScoreBreakdownJson>(),
  firstSeen: timestamp('first_seen', { withTimezone: true, mode: 'date' }),
  // set when this wallet was auto-added because a watched wallet transferred SOL to it
  parentWallet: text('parent_wallet'),
  fundingSource: text('funding_source'),
  isActive: boolean('is_active').notNull().default(true),
  muted: boolean('muted').notNull().default(false),
  // newest processed signature — reconciliation fetches history `until` this point
  lastSig: text('last_sig'),
  lastActivityTs: timestamp('last_activity_ts', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
});

export type WalletRow = typeof wallets.$inferSelect;
export type NewWalletRow = typeof wallets.$inferInsert;
export type WalletTier = NonNullable<WalletRow['tier']>;
