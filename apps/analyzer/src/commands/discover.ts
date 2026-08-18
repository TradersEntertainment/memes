import { tokens } from '@insiderscope/db';
import {
  bestPair,
  chunk,
  discoveryFloorUsd,
  fetchBoostedTokens,
  fetchLatestTokenProfiles,
  getPairsForTokens,
  pairMcUsd,
} from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { upsertToken } from '../lib/persist';

/**
 * Best-effort candidate discovery. DexScreener exposes no "all pairs ≥ $10M"
 * screener, so this (1) refreshes the observed ATH of every known token and
 * (2) scans the boosted/profile feeds for new Solana tokens currently above the
 * threshold. The CSV import remains the primary seeding path.
 */
export async function runDiscover(ctx: AnalyzerCtx): Promise<void> {
  const { db, cfg, log } = ctx;

  // 1. ATH refresh for known tokens
  const known = await db.select({ mint: tokens.mint }).from(tokens);
  let refreshed = 0;
  for (const group of chunk(known.map((t) => t.mint), 30)) {
    const pairsByMint = await getPairsForTokens(group);
    for (const [mint, pairs] of pairsByMint) {
      const pair = bestPair(pairs);
      const mc = pairMcUsd(pair);
      if (!pair || mc == null) continue;
      await upsertToken(db, {
        mint,
        symbol: pair.baseToken.symbol ?? null,
        name: pair.baseToken.name ?? null,
        poolAddress: pair.pairAddress,
        athMcUsd: mc,
        athTs: new Date(),
      });
      refreshed += 1;
    }
  }
  log(`discover: refreshed ${refreshed}/${known.length} known tokens`);

  // 2. New candidates from boosted/profile feeds
  const knownSet = new Set(known.map((t) => t.mint));
  const seen = [...new Set([...(await fetchBoostedTokens()), ...(await fetchLatestTokenProfiles())])];
  const fresh = seen.filter((m) => !knownSet.has(m));
  let added = 0;
  for (const group of chunk(fresh, 30)) {
    const pairsByMint = await getPairsForTokens(group);
    for (const [mint, pairs] of pairsByMint) {
      const pair = bestPair(pairs);
      const mc = pairMcUsd(pair);
      // Pair-age-aware bar: pairs opened inside the recency window qualify at
      // the lower RECENT_MIN_MC_USD, older ones still need the full threshold.
      if (!pair || mc == null || mc < discoveryFloorUsd(cfg, pair.pairCreatedAt)) continue;
      await upsertToken(db, {
        mint,
        symbol: pair.baseToken.symbol ?? null,
        name: pair.baseToken.name ?? null,
        poolAddress: pair.pairAddress,
        athMcUsd: mc,
        athTs: new Date(),
        status: 'candidate',
      });
      added += 1;
    }
  }
  log(
    `discover: ${added} new candidates (≥ $${cfg.DISCOVER_MIN_MC_USD.toLocaleString('en-US')}, or ≥ $${cfg.RECENT_MIN_MC_USD.toLocaleString('en-US')} for pairs younger than ${cfg.RECENT_WINDOW_DAYS}d) from ${fresh.length} scanned — ATH values are best-effort (max observed)`,
  );
}
