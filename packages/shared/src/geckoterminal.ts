import { GECKOTERMINAL_API_BASE } from './constants';

/**
 * GeckoTerminal public API (keyless, ~30 req/min): the "what's running RIGHT
 * NOW" discovery source. DexScreener's boosted/profile feeds are paid
 * placements with narrow coverage; GeckoTerminal's trending and top-volume
 * pool lists are the actual current runners — exactly what the recency-first
 * scan needs to feed on. Best-effort everywhere, like the DexScreener client:
 * any network/shape problem returns an empty list and the caller moves on.
 */

export interface GeckoPool {
  mint: string;
  poolAddress: string | null;
  symbol: string | null;
  name: string | null;
  /** market_cap_usd, falling back to fdv_usd (both refer to the base token). */
  mcUsd: number | null;
  /** Pool creation time, epoch ms. */
  poolCreatedAt: number | null;
}

/** Quote-side mints that are never the token we're hunting. */
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface GeckoPoolEntry {
  attributes?: {
    name?: string;
    address?: string;
    pool_created_at?: string;
    fdv_usd?: string | number | null;
    market_cap_usd?: string | number | null;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
  };
}

async function gtFetch(path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  try {
    const res = await fetchImpl(`${GECKOTERMINAL_API_BASE}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // best-effort — discovery just gets nothing this round
  }
}

function toFiniteNumber(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePool(entry: GeckoPoolEntry): GeckoPool | null {
  const baseId = entry.relationships?.base_token?.data?.id;
  if (!baseId || !baseId.startsWith('solana_')) return null;
  const mint = baseId.slice('solana_'.length);
  // Skip flipped pools (wSOL/stable as base): fdv/market cap would describe the
  // quote asset, not a memecoin — and skip anything that isn't a real address.
  if (QUOTE_MINTS.has(mint) || !BASE58_ADDRESS.test(mint)) return null;

  const a = entry.attributes ?? {};
  const createdMs = a.pool_created_at ? Date.parse(a.pool_created_at) : Number.NaN;
  // attributes.name is "SYMBOL / SOL" — the symbol is a best-effort hint; the
  // hourly DexScreener refresh fills in proper metadata later.
  const symbol = a.name?.split('/')[0]?.trim() || null;
  return {
    mint,
    poolAddress: a.address ?? null,
    symbol,
    name: null,
    mcUsd: toFiniteNumber(a.market_cap_usd) ?? toFiniteNumber(a.fdv_usd),
    poolCreatedAt: Number.isFinite(createdMs) ? createdMs : null,
  };
}

/**
 * Fetch Solana pools — 'trending' (GeckoTerminal's hot list) or 'top' (24h
 * volume leaders), `pages` pages of ~20 each. Deduped by mint, keeping the
 * entry with the highest market cap.
 */
export async function fetchGeckoSolanaPools(
  kind: 'trending' | 'top',
  pages = 2,
  fetchImpl?: typeof fetch,
): Promise<GeckoPool[]> {
  const path =
    kind === 'trending'
      ? '/api/v2/networks/solana/trending_pools'
      : '/api/v2/networks/solana/pools?sort=h24_volume_usd_desc';
  const sep = path.includes('?') ? '&' : '?';

  const byMint = new Map<string, GeckoPool>();
  for (let page = 1; page <= pages; page++) {
    const body = (await gtFetch(`${path}${sep}page=${page}`, fetchImpl)) as {
      data?: GeckoPoolEntry[] | null;
    } | null;
    const entries = Array.isArray(body?.data) ? body.data : [];
    for (const entry of entries) {
      const pool = parsePool(entry);
      if (!pool) continue;
      const seen = byMint.get(pool.mint);
      if (!seen || (pool.mcUsd ?? 0) > (seen.mcUsd ?? 0)) byMint.set(pool.mint, pool);
    }
    if (entries.length === 0) break; // out of pages (or the API said no)
  }
  return [...byMint.values()];
}
