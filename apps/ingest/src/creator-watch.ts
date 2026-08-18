import { and, eq, gte, inArray, isNotNull, tokens, wallets, type Db } from '@insiderscope/db';

export interface KnownCreatorHit {
  kind: 'creator' | 'insider';
  label: string | null;
  /** Best past token for creators (symbol + ATH), null for watched wallets. */
  pastSymbol: string | null;
  pastAthUsd: number | null;
  tier: string | null;
  score: number | null;
}

const TTL_MS = 5 * 60_000;
let cache: { at: number; map: Map<string, KnownCreatorHit> } | null = null;

/**
 * Wallets whose new pump.fun launches deserve an instant alert: creators of past
 * $10M+ tokens, and every active insider/watch wallet. PumpPortal delivers
 * thousands of launches a day, so this is served from a 5-minute in-memory cache
 * instead of a query per launch.
 */
export async function lookupKnownCreator(
  db: Db,
  minAthUsd: number,
  address: string | undefined,
): Promise<KnownCreatorHit | null> {
  if (!address) return null;
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const map = new Map<string, KnownCreatorHit>();

    const creatorRows = await db
      .select({ creator: tokens.creatorWallet, symbol: tokens.symbol, ath: tokens.athMcUsd })
      .from(tokens)
      .where(and(isNotNull(tokens.creatorWallet), gte(tokens.athMcUsd, minAthUsd)));
    for (const r of creatorRows) {
      const existing = map.get(r.creator!);
      if (!existing || (r.ath ?? 0) > (existing.pastAthUsd ?? 0)) {
        map.set(r.creator!, {
          kind: 'creator',
          label: null,
          pastSymbol: r.symbol,
          pastAthUsd: r.ath,
          tier: null,
          score: null,
        });
      }
    }

    const walletRows = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch'])));
    for (const w of walletRows) {
      if (!map.has(w.address)) {
        map.set(w.address, {
          kind: 'insider',
          label: w.label,
          pastSymbol: null,
          pastAthUsd: null,
          tier: w.tier,
          score: w.insiderScore,
        });
      }
    }

    cache = { at: Date.now(), map };
  }
  return cache.map.get(address) ?? null;
}

/** Test hook. */
export function resetCreatorWatchCache(): void {
  cache = null;
}
