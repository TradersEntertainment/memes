import { sql, tokens, wallets, type Db, type NewTokenRow } from '@insiderscope/db';
import { chunk } from '@insiderscope/shared';

/** Create wallet rows (tier null = unscored candidate) without touching existing ones. */
export async function ensureWallets(db: Db, addresses: string[], firstSeen?: Date): Promise<void> {
  const unique = [...new Set(addresses)];
  for (const group of chunk(unique, 500)) {
    if (group.length === 0) continue;
    await db
      .insert(wallets)
      .values(group.map((address) => ({ address, firstSeen: firstSeen ?? new Date() })))
      .onConflictDoNothing();
  }
}

/**
 * Idempotent token upsert: fills blanks and lifts the ATH, never downgrades
 * existing data (re-running an import must be a no-op).
 */
export async function upsertToken(db: Db, row: NewTokenRow): Promise<void> {
  await db
    .insert(tokens)
    .values(row)
    .onConflictDoUpdate({
      target: tokens.mint,
      set: {
        symbol: sql`coalesce(${tokens.symbol}, excluded.symbol)`,
        name: sql`coalesce(${tokens.name}, excluded.name)`,
        poolAddress: sql`coalesce(${tokens.poolAddress}, excluded.pool_address)`,
        bondingCurve: sql`coalesce(${tokens.bondingCurve}, excluded.bonding_curve)`,
        athMcUsd: sql`nullif(greatest(coalesce(${tokens.athMcUsd}, 0), coalesce(excluded.ath_mc_usd, 0)), 0)`,
        athTs: sql`case when coalesce(excluded.ath_mc_usd, 0) > coalesce(${tokens.athMcUsd}, 0) then excluded.ath_ts else ${tokens.athTs} end`,
      },
    });
}
