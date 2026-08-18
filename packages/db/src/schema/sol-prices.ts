import { doublePrecision, pgTable, timestamp } from 'drizzle-orm/pg-core';

/**
 * Hourly SOL/USD close prices (Binance klines), keyed by the hour-floored timestamp.
 * Used to convert SOL-denominated historical market caps and PnL into USD.
 */
export const solPrices = pgTable('sol_prices', {
  ts: timestamp('ts', { withTimezone: true, mode: 'date' }).primaryKey(),
  priceUsd: doublePrecision('price_usd').notNull(),
});

export type SolPriceRow = typeof solPrices.$inferSelect;
