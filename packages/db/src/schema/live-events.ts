import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { liveEventTypeEnum } from './enums';
import { wallets } from './wallets';

/**
 * Events captured live (webhook) or by the reconciliation backfill. One transaction
 * can produce several rows (transfer_out for the sender + transfer_in for a watched
 * receiver), so uniqueness is per (signature, wallet, event_type). Replays — webhook
 * retries and reconciliation overlap — are dropped by this constraint, which is what
 * makes the whole pipeline idempotent.
 */
export const liveEvents = pgTable(
  'live_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet')
      .notNull()
      .references(() => wallets.address),
    eventType: liveEventTypeEnum('event_type').notNull(),
    // null for plain SOL transfers
    mint: text('mint'),
    amountSol: doublePrecision('amount_sol'),
    tokenAmount: doublePrecision('token_amount'),
    mcAtEvent: doublePrecision('mc_at_event'),
    // counterparty wallet for transfer events
    counterparty: text('counterparty'),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
    signature: text('signature').notNull(),
    alerted: boolean('alerted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('live_events_sig_wallet_type_uq').on(t.signature, t.wallet, t.eventType),
    index('live_events_wallet_ts_idx').on(t.wallet, t.ts.desc()),
    index('live_events_ts_idx').on(t.ts.desc()),
  ],
);

export type LiveEventRow = typeof liveEvents.$inferSelect;
export type NewLiveEventRow = typeof liveEvents.$inferInsert;
