import { upsertToken } from '@insiderscope/analyzer';
import { and, eq, gte, isNotNull, isNull, liveEvents, sql, tokens } from '@insiderscope/db';
import { bestPair, chunk, getPairsForTokens, pairMcUsd } from '@insiderscope/shared';
import type { AppCtx } from '../context';
import { maybeAutoScan } from './nightly-rescore';

/**
 * The flywheel (hourly): keep ATHs fresh for every token we know AND every mint
 * a watched wallet bought recently. When one of those crosses the $10M line it
 * becomes a candidate, the pipeline crawls ITS early buyers, and the insider
 * universe grows on its own — insiders lead us to tokens, tokens lead us to more
 * insiders. DexScreener only (no Helius credits): ~a handful of batch calls.
 */
export async function refreshAth(ctx: AppCtx): Promise<void> {
  const { db, cfg, log } = ctx;

  const known = await db.select({ mint: tokens.mint }).from(tokens);
  const bought = await db
    .selectDistinct({ mint: liveEvents.mint })
    .from(liveEvents)
    .where(
      and(
        eq(liveEvents.eventType, 'buy'),
        isNotNull(liveEvents.mint),
        gte(liveEvents.ts, new Date(Date.now() - 7 * 86_400_000)),
      ),
    );
  const knownSet = new Set(known.map((r) => r.mint));
  const mints = [...new Set([...knownSet, ...bought.map((r) => r.mint!)])];
  if (mints.length === 0) return;

  let refreshed = 0;
  let discovered = 0;
  for (const group of chunk(mints, 30)) {
    const pairsByMint = await getPairsForTokens(group);
    for (const [mint, pairs] of pairsByMint) {
      const pair = bestPair(pairs);
      const mcUsd = pairMcUsd(pair);
      if (!pair || mcUsd == null) continue;
      if (!knownSet.has(mint) && mcUsd < cfg.DISCOVER_MIN_MC_USD) continue; // small live buy — not our universe yet
      await upsertToken(db, {
        mint,
        symbol: pair.baseToken.symbol ?? null,
        name: pair.baseToken.name ?? null,
        poolAddress: pair.pairAddress,
        athMcUsd: mcUsd,
        athTs: new Date(),
        status: 'candidate',
      });
      if (knownSet.has(mint)) refreshed += 1;
      else discovered += 1;
    }
  }

  // Anything now above the threshold that was never crawled → run the pipeline.
  const crossers = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tokens)
    .where(
      and(
        eq(tokens.status, 'candidate'),
        isNull(tokens.launchTs),
        gte(tokens.athMcUsd, cfg.DISCOVER_MIN_MC_USD),
      ),
    );
  const pending = crossers[0]?.n ?? 0;
  log(`ath-refresh: ${refreshed} refreshed, ${discovered} new ≥$10M from live buys, ${pending} uncrawled`);
  if (pending > 0) {
    await maybeAutoScan(ctx, 'ath-cross');
  }
}
