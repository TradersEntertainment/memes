import {
  bigserial,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Native SOL transfers between wallets (funding graph edges). One transaction can
 * carry several native transfers, so uniqueness is per (signature, from, to) —
 * transfers between the same pair inside one tx are aggregated before insert.
 */
export const transfers = pgTable(
  'transfers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    fromWallet: text('from_wallet').notNull(),
    toWallet: text('to_wallet').notNull(),
    amountSol: doublePrecision('amount_sol').notNull(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
    signature: text('signature').notNull(),
  },
  (t) => [
    uniqueIndex('transfers_sig_from_to_uq').on(t.signature, t.fromWallet, t.toWallet),
    index('transfers_from_idx').on(t.fromWallet),
    index('transfers_to_idx').on(t.toWallet),
  ],
);

export type TransferRow = typeof transfers.$inferSelect;
export type NewTransferRow = typeof transfers.$inferInsert;
