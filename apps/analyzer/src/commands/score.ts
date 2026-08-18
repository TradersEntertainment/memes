import {
  and,
  eq,
  inArray,
  positions,
  sql,
  tokens,
  wallets,
  type Db,
  type WalletTier,
} from '@insiderscope/db';
import {
  ensureSolPriceRange,
  getSolPriceUsdAt,
  HeliusCircuitOpenError,
  scoreWallet,
  scoringConfig,
  shortAddr,
  type PositionForScoring,
} from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { ensureWallets } from '../lib/persist';
import { fetchWalletSwapAggregates, type MintAggregate } from '../lib/wallet-history';

export async function runScoreAll(ctx: AnalyzerCtx): Promise<void> {
  const withPositions = await ctx.db
    .selectDistinct({ address: positions.wallet })
    .from(positions)
    .innerJoin(tokens, eq(positions.mint, tokens.mint))
    .where(eq(tokens.status, 'analyzed'));
  const tiered = await ctx.db
    .select({ address: wallets.address })
    .from(wallets)
    .where(and(inArray(wallets.tier, ['insider', 'watch']), eq(wallets.isActive, true)));

  const union = [...new Set([...withPositions, ...tiered].map((r) => r.address))];

  // Credit budget: a full-history refetch per wallet per night adds up fast.
  // Skip wallets that were scored recently AND have shown no activity since —
  // their inputs cannot have changed. New activity or a stale score reruns them.
  const staleBefore = new Date(Date.now() - ctx.cfg.SCORE_REFRESH_DAYS * 86_400_000);
  const rows =
    union.length > 0
      ? await ctx.db.select().from(wallets).where(inArray(wallets.address, union))
      : [];
  const byAddress = new Map(rows.map((r) => [r.address, r]));
  const all = union.filter((address) => {
    const w = byAddress.get(address);
    if (!w || w.insiderScore == null || !w.updatedAt) return true; // never scored
    if (w.updatedAt < staleBefore) return true; // score too old
    return w.lastActivityTs != null && w.lastActivityTs > w.updatedAt; // traded since
  });

  ctx.log(
    `score: ${all.length} wallet(s) to score (${union.length - all.length} fresh, skipped)`,
  );
  for (const address of all) {
    try {
      await runScoreWallet(ctx, address);
    } catch (err) {
      if (err instanceof HeliusCircuitOpenError) throw err; // credits gone — stop the stage
      ctx.log(`score ${shortAddr(address)} failed: ${err}`);
    }
  }
}

export async function runScoreWallet(ctx: AnalyzerCtx, address: string): Promise<void> {
  const { db, cfg, log } = ctx;
  await ensureWallets(db, [address]);

  // Survivorship countermeasure: complete swap history, losers included.
  const agg = await fetchWalletSwapAggregates(ctx, address);
  if (agg.oldestTs && agg.newestTs) {
    await ensureSolPriceRange(db, agg.oldestTs, agg.newestTs, {
      fallbackUsd: cfg.SOL_PRICE_FALLBACK_USD,
    }).catch((err) => log(`sol price backfill failed (${err}) — USD PnL may be partial`));
  }

  const priceOpts = { fallbackUsd: cfg.SOL_PRICE_FALLBACK_USD };
  for (const [mint, m] of agg.perMint) {
    await upsertHistoryPosition(db, address, mint, m, priceOpts);
  }

  const rows = await db
    .select({
      mint: positions.mint,
      tokenAthMcUsd: tokens.athMcUsd,
      creatorLinked: positions.creatorLinked,
      secondsAfterLaunch: positions.secondsAfterLaunch,
      realizedPnlUsd: positions.realizedPnlUsd,
      stillHolding: positions.stillHolding,
      entryMcUsd: positions.entryMcUsd,
    })
    .from(positions)
    .leftJoin(tokens, eq(positions.mint, tokens.mint))
    .where(eq(positions.wallet, address));

  const input: PositionForScoring[] = rows.map((r) => ({
    mint: r.mint,
    tokenAthMcUsd: r.tokenAthMcUsd,
    creatorLinked: r.creatorLinked,
    secondsAfterLaunch: r.secondsAfterLaunch,
    realizedPnlUsd: r.realizedPnlUsd,
    stillHolding: r.stillHolding,
    entryMcUsd: r.entryMcUsd,
  }));
  const result = scoreWallet({ positions: input, totalTrades: agg.totalTrades }, scoringConfig(cfg));

  const decided = rows.filter((r) => r.realizedPnlUsd != null);
  const wins = decided.filter((r) => r.realizedPnlUsd! > 0).length;
  const rawWinRate = decided.length > 0 ? wins / decided.length : null;
  const totalPnlUsd = decided.reduce((s, r) => s + r.realizedPnlUsd!, 0);
  const entryMcs = rows.map((r) => r.entryMcUsd).filter((v): v is number => v != null);
  const avgEntryMc =
    entryMcs.length > 0 ? entryMcs.reduce((s, v) => s + v, 0) / entryMcs.length : null;

  const current = (await db.select().from(wallets).where(eq(wallets.address, address)).limit(1))[0];
  const currentTier = current?.tier ?? null;
  // Tier merge: blacklist always wins; insider/watch follow the score; a wallet
  // that falls below 50 keeps a sticky floor (insider demotes to watch, manual
  // watch/probation stay) so live watching never silently drops wallets.
  let newTier: WalletTier | null;
  if (result.tier === 'blacklist') newTier = 'blacklist';
  else if (result.tier != null) newTier = result.tier;
  else newTier = currentTier === 'insider' ? 'watch' : currentTier;

  await db
    .update(wallets)
    .set({
      insiderScore: result.score,
      winRate: rawWinRate,
      totalTrades: agg.totalTrades,
      totalPnlUsd: decided.length > 0 ? totalPnlUsd : null,
      avgEntryMc,
      scoreBreakdown: result.breakdown,
      tier: newTier,
      isActive: newTier === 'blacklist' ? false : current?.isActive ?? true,
      updatedAt: new Date(),
    })
    .where(eq(wallets.address, address));

  log(
    `${shortAddr(address)}: score ${result.score} → ${newTier ?? 'unranked'}${
      result.blacklistReason ? ` (${result.blacklistReason})` : ''
    } | ${agg.totalTrades}${agg.truncated ? '+' : ''} trades, ${rows.length} positions, ${
      decided.length
    } decided, pnl ${decided.length > 0 ? `$${Math.round(totalPnlUsd).toLocaleString('en-US')}` : 'n/a'}`,
  );
}

async function upsertHistoryPosition(
  db: Db,
  wallet: string,
  mint: string,
  m: MintAggregate,
  priceOpts: { fallbackUsd: number | null },
): Promise<void> {
  const costUsd = await sumUsd(db, m.buyEvents, priceOpts);
  const proceedsUsd = await sumUsd(db, m.sellEvents, priceOpts);

  let realizedPnlUsd: number | null = null;
  if (m.sellTokens > 0 && costUsd != null && proceedsUsd != null) {
    const soldFrac = m.buyTokens > 0 ? Math.min(1, m.sellTokens / m.buyTokens) : 1;
    realizedPnlUsd = proceedsUsd - costUsd * soldFrac;
  }
  const stillHolding = m.buyTokens > 0 && m.sellTokens < 0.9 * m.buyTokens;

  await db
    .insert(positions)
    .values({
      wallet,
      mint,
      firstBuyTs: m.firstBuyTs,
      firstBuySlot: m.firstBuySlot,
      entryAmountSol: m.buySol > 0 ? m.buySol : null,
      tokenAmount: m.buyTokens > 0 ? m.buyTokens : null,
      realizedPnlUsd,
      stillHolding,
    })
    .onConflictDoUpdate({
      target: [positions.wallet, positions.mint],
      set: {
        // full-history PnL supersedes the partial in-crawl value; entry detail
        // from early-buyers (MC, timing, supply %) is never clobbered
        realizedPnlUsd: sql`coalesce(excluded.realized_pnl_usd, ${positions.realizedPnlUsd})`,
        stillHolding: sql`excluded.still_holding`,
        firstBuyTs: sql`coalesce(${positions.firstBuyTs}, excluded.first_buy_ts)`,
        firstBuySlot: sql`coalesce(${positions.firstBuySlot}, excluded.first_buy_slot)`,
        entryAmountSol: sql`coalesce(${positions.entryAmountSol}, excluded.entry_amount_sol)`,
        tokenAmount: sql`coalesce(${positions.tokenAmount}, excluded.token_amount)`,
      },
    });
}

async function sumUsd(
  db: Db,
  events: { sol: number; ts: Date }[],
  priceOpts: { fallbackUsd: number | null },
): Promise<number | null> {
  if (events.length === 0) return 0;
  let total = 0;
  for (const ev of events) {
    const price = await getSolPriceUsdAt(db, ev.ts, priceOpts);
    if (price == null) return null;
    total += ev.sol * price;
  }
  return total;
}
