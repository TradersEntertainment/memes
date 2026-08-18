import { DEXSCREENER_API_BASE } from './constants';
import { chunk } from './utils';

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol?: string; name?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
}

async function dsFetch<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T | null> {
  try {
    const res = await fetchImpl(`${DEXSCREENER_API_BASE}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // DexScreener is best-effort everywhere — callers fall back
  }
}

/** Batch pair lookup (≤30 mints per request). Solana pairs only, keyed by mint. */
export async function getPairsForTokens(
  mints: string[],
  fetchImpl?: typeof fetch,
): Promise<Map<string, DexPair[]>> {
  const out = new Map<string, DexPair[]>();
  for (const group of chunk(mints, 30)) {
    const data = await dsFetch<{ pairs?: DexPair[] | null }>(
      `/latest/dex/tokens/${group.join(',')}`,
      fetchImpl,
    );
    for (const pair of data?.pairs ?? []) {
      if (pair.chainId !== 'solana') continue;
      const key = pair.baseToken?.address;
      if (!key) continue;
      const arr = out.get(key) ?? [];
      arr.push(pair);
      out.set(key, arr);
    }
  }
  return out;
}

/** Deepest pair wins (liquidity, then 24h volume). */
export function bestPair(pairs: DexPair[]): DexPair | null {
  if (pairs.length === 0) return null;
  return [...pairs].sort(
    (a, b) =>
      (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0) ||
      (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0),
  )[0]!;
}

export function pairMcUsd(pair: DexPair | null): number | null {
  if (!pair) return null;
  const mc = pair.marketCap ?? pair.fdv;
  return mc != null && Number.isFinite(mc) && mc > 0 ? mc : null;
}

/** Current market cap for a mint, or null when DexScreener doesn't know it yet. */
export async function getLiveMcFromDexscreener(
  mint: string,
  fetchImpl?: typeof fetch,
): Promise<{ mcUsd: number; pair: DexPair } | null> {
  const pairs = (await getPairsForTokens([mint], fetchImpl)).get(mint) ?? [];
  const pair = bestPair(pairs);
  const mcUsd = pairMcUsd(pair);
  return pair && mcUsd != null ? { mcUsd, pair } : null;
}

interface BoostedTokenEntry {
  chainId?: string;
  tokenAddress?: string;
}

/**
 * Best-effort discover sources. DexScreener has no public "all pairs above X MC"
 * screener endpoint, so `analyzer discover` combines these lists with an ATH
 * refresh of already-known tokens; the CSV import remains the primary path.
 */
export async function fetchBoostedTokens(fetchImpl?: typeof fetch): Promise<string[]> {
  const data = await dsFetch<BoostedTokenEntry[]>('/token-boosts/latest/v1', fetchImpl);
  return (data ?? [])
    .filter((t) => t.chainId === 'solana' && t.tokenAddress)
    .map((t) => t.tokenAddress!);
}

export async function fetchLatestTokenProfiles(fetchImpl?: typeof fetch): Promise<string[]> {
  const data = await dsFetch<BoostedTokenEntry[]>('/token-profiles/latest/v1', fetchImpl);
  return (data ?? [])
    .filter((t) => t.chainId === 'solana' && t.tokenAddress)
    .map((t) => t.tokenAddress!);
}
