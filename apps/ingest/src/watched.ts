import { and, eq, inArray, wallets, type Db, type WalletTier } from '@insiderscope/db';

export interface WatchedWallet {
  address: string;
  tier: WalletTier | null;
  label: string | null;
  muted: boolean;
  insiderScore: number | null;
  parentWallet: string | null;
  bigTokenCount: number | null;
}

const TTL_MS = 30_000;
let cache: { at: number; map: Map<string, WatchedWallet> } | null = null;

/** Active insider/watch/probation wallets, cached 30s (single-instance ingest). */
export async function getWatchedWallets(db: Db): Promise<Map<string, WatchedWallet>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const rows = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch', 'probation'])));
  const map = new Map<string, WatchedWallet>(
    rows.map((r) => [
      r.address,
      {
        address: r.address,
        tier: r.tier,
        label: r.label,
        muted: r.muted,
        insiderScore: r.insiderScore,
        parentWallet: r.parentWallet,
        bigTokenCount: r.scoreBreakdown?.bigTokenCount ?? null,
      },
    ]),
  );
  cache = { at: Date.now(), map };
  return map;
}

export function invalidateWatchedCache(): void {
  cache = null;
}
