import { and, eq, gte, isNull, or, positions, sql, tokens, wallets, type Db } from '@insiderscope/db';
import {
  deriveBondingCurvePda,
  ensureSolPriceRange,
  getLiveMcFromDexscreener,
  HeliusCircuitOpenError,
  detectLaunch,
  mcUsdAt,
  PUMPFUN_TOTAL_SUPPLY,
  swapDerivedMcSol,
  type EnhancedTx,
  type NormalizedSwap,
} from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { extractEarlyBuyers, type EarlyBuy } from '../lib/early-buyers';
import { ensureWallets, upsertToken } from '../lib/persist';

/**
 * Repair pass for tokens analyzed via a deep AMM-pool crawl before the
 * truncation guard existed: their "launch" was a mid-history transaction and
 * their "early buyers" random recent traders. Clear the fabricated early fields
 * and re-candidate the token — the guarded crawl then either analyzes it
 * honestly or marks it skipped.
 */
export async function repairMislabeledTokens(ctx: AnalyzerCtx): Promise<number> {
  const bad = await ctx.db
    .select({ mint: tokens.mint })
    .from(tokens)
    .where(and(eq(tokens.status, 'analyzed'), isNull(tokens.bondingCurve)));
  for (const { mint } of bad) {
    await ctx.db
      .update(positions)
      .set({
        secondsAfterLaunch: null,
        entryMcUsd: null,
        pctOfSupply: null,
        firstBuySlot: null,
      })
      .where(eq(positions.mint, mint));
    await ctx.db
      .update(tokens)
      .set({ status: 'candidate', launchTs: null, launchSlot: null, creatorWallet: null })
      .where(eq(tokens.mint, mint));
  }
  if (bad.length > 0) {
    ctx.log(`repair: ${bad.length} pool-crawled token(s) re-candidated, early fields cleared`);
  }
  return bad.length;
}

/** Start of the recency window: "peaked within the last 1-2 weeks". */
function recentCutoff(cfg: AnalyzerCtx['cfg']): Date {
  return new Date(Date.now() - cfg.RECENT_WINDOW_DAYS * 86_400_000);
}

/**
 * Candidates worth crawling: manual/seed additions (no ATH yet), ≥ $10M at any
 * point, or — the recency arm — ≥ $5M with the peak inside the recent window
 * (upsertToken only advances athTs on a NEW high, so a recent athTs means the
 * token crossed that level recently, not that we merely re-checked it).
 */
export function crawlableCandidatesWhere(cfg: AnalyzerCtx['cfg']) {
  return and(
    eq(tokens.status, 'candidate'),
    or(
      isNull(tokens.athMcUsd),
      gte(tokens.athMcUsd, cfg.DISCOVER_MIN_MC_USD),
      and(
        gte(tokens.athMcUsd, cfg.RECENT_MIN_MC_USD),
        gte(tokens.athTs, recentCutoff(cfg)),
      ),
    ),
  );
}

/** Recent-window runners first (newest peak first), then the backlog. */
export function recentFirstOrder(cfg: AnalyzerCtx['cfg']) {
  const cutoff = recentCutoff(cfg).toISOString();
  return [
    sql`case when ${tokens.athTs} >= ${cutoff}::timestamptz and ${tokens.athMcUsd} >= ${cfg.RECENT_MIN_MC_USD} then 0 else 1 end`,
    sql`${tokens.athTs} desc nulls last`,
  ];
}

export async function runEarlyBuyersAll(ctx: AnalyzerCtx): Promise<void> {
  await repairMislabeledTokens(ctx);
  // Recent runners first — so if credits run out mid-pass, the "last 1-2 weeks"
  // focus is what got done.
  const candidates = await ctx.db
    .select({ mint: tokens.mint })
    .from(tokens)
    .where(crawlableCandidatesWhere(ctx.cfg))
    .orderBy(...recentFirstOrder(ctx.cfg));
  ctx.log(`early-buyers: ${candidates.length} candidate token(s), recent peaks first`);
  for (const { mint } of candidates) {
    try {
      await runEarlyBuyers(ctx, mint);
    } catch (err) {
      // Circuit open = API credits/limit gone: abort the stage, the next pass
      // resumes from the remaining 'candidate' rows. Anything else is one bad
      // token — log and keep going.
      if (err instanceof HeliusCircuitOpenError) throw err;
      ctx.log(`early-buyers ${mint} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function runEarlyBuyers(ctx: AnalyzerCtx, mint: string): Promise<void> {
  const { db, cfg, log } = ctx;
  await upsertToken(db, { mint, status: 'candidate' });

  // Crawl the bounded address: pump.fun bonding curve first, AMM pool as fallback.
  // Never the mint itself — a $10M token's mint history is millions of txs.
  const curve = deriveBondingCurvePda(mint);
  let crawlAddress = curve;
  let drained = await ctx.helius.fetchHistoryOldestFirstDetailed(curve, {
    maxPages: cfg.HELIUS_MAX_PAGES_TOKEN,
  });

  if (drained.txs.length === 0) {
    const existing = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
    let pool = existing[0]?.poolAddress ?? null;
    if (!pool) {
      const live = await getLiveMcFromDexscreener(mint);
      pool = live?.pair.pairAddress ?? null;
    }
    if (pool) {
      log(`${mint}: empty bonding curve history, crawling pool ${pool}`);
      crawlAddress = pool;
      drained = await ctx.helius.fetchHistoryOldestFirstDetailed(pool, {
        maxPages: cfg.HELIUS_MAX_PAGES_TOKEN,
      });
    }
  }
  const txs = drained.txs;

  if (txs.length === 0) {
    log(`${mint}: no crawlable history (bonding curve empty, no pool found) — skipped`);
    await db.update(tokens).set({ status: 'skipped' }).where(eq(tokens.mint, mint));
    return;
  }

  if (drained.truncated) {
    // The page cap stopped before the address's real beginning: the launch is
    // NOT in this window, and "early buyers" from it would be random recent
    // traders. Honest answer: this token's history is too deep for the cheap
    // crawl (typical for Raydium-native giants) — skip instead of fabricating.
    log(
      `${mint}: history deeper than ${cfg.HELIUS_MAX_PAGES_TOKEN} pages — launch unreachable, skipped (raise HELIUS_MAX_PAGES_TOKEN only if you accept the credit cost)`,
    );
    await db.update(tokens).set({ status: 'skipped' }).where(eq(tokens.mint, mint));
    return;
  }

  const launch = detectLaunch(txs);
  if (!launch) {
    log(`${mint}: could not detect launch — skipped`);
    await db.update(tokens).set({ status: 'skipped' }).where(eq(tokens.mint, mint));
    return;
  }

  const supply =
    launch.platform === 'pumpfun'
      ? PUMPFUN_TOTAL_SUPPLY
      : await ctx.helius
          .getTokenSupply(mint)
          .then((s) => s.uiAmount || PUMPFUN_TOTAL_SUPPLY)
          .catch(() => PUMPFUN_TOTAL_SUPPLY);

  await db
    .update(tokens)
    .set({
      launchPlatform: launch.platform,
      launchTs: launch.launchTs,
      launchSlot: launch.launchSlot,
      creatorWallet: launch.creator,
      bondingCurve: crawlAddress === curve ? curve : undefined,
      poolAddress: crawlAddress !== curve ? crawlAddress : undefined,
      status: 'analyzed',
    })
    .where(eq(tokens.mint, mint));

  const { buys, sells } = extractEarlyBuyers(txs, launch, {
    mint,
    windowSec: cfg.EARLY_WINDOW_MIN * 60,
    maxBuyers: cfg.EARLY_MAX_BUYERS,
  });
  log(
    `${mint}: ${txs.length} txs crawled (${crawlAddress === curve ? 'curve' : 'pool'}), launch ${launch.platform} @ ${launch.launchTs.toISOString()}, ${buys.length} early buyers, ${sells.length} early-buyer sells`,
  );
  if (buys.length === 0) return;

  const lastTs = txs[txs.length - 1]!.timestamp * 1000;
  await ensureSolPriceRange(db, launch.launchTs, new Date(lastTs), {
    fallbackUsd: cfg.SOL_PRICE_FALLBACK_USD,
  }).catch((err) => log(`sol price backfill failed (${err}) — USD fields may be null`));

  await ensureWallets(db, buys.map((b) => b.wallet), launch.launchTs);

  const sellsByWallet = new Map<string, NormalizedSwap[]>();
  for (const sell of sells) {
    const arr = sellsByWallet.get(sell.wallet) ?? [];
    arr.push(sell);
    sellsByWallet.set(sell.wallet, arr);
  }

  const priceOpts = { fallbackUsd: cfg.SOL_PRICE_FALLBACK_USD };
  for (const buy of buys) {
    await upsertEarlyPosition(db, buy, {
      mint,
      supply,
      sells: sellsByWallet.get(buy.wallet) ?? [],
      priceOpts,
    });
  }
  log(`${mint}: ${buys.length} positions upserted`);
}

interface PositionInputs {
  mint: string;
  supply: number;
  sells: NormalizedSwap[];
  priceOpts: { fallbackUsd: number | null };
}

async function upsertEarlyPosition(db: Db, buy: EarlyBuy, inp: PositionInputs): Promise<void> {
  const entryMcSol = swapDerivedMcSol(buy.solAmount, buy.tokenAmount, inp.supply);
  const entryMcUsd = await mcUsdAt(db, entryMcSol, buy.ts, inp.priceOpts);

  // Exit metrics from in-crawl sells. Sells beyond the crawled range (post-
  // graduation) are folded in later by `analyzer score` via full wallet history.
  let exitMcUsd: number | null = null;
  let realizedPnlUsd: number | null = null;
  let stillHolding = true;
  let soldTokens = 0;
  if (inp.sells.length > 0) {
    let mcWeighted = 0;
    let proceedsUsd = 0;
    let usdOk = true;
    for (const sell of inp.sells) {
      soldTokens += sell.tokenAmount;
      const sellMcSol = swapDerivedMcSol(sell.solAmount, sell.tokenAmount, inp.supply);
      const sellMcUsd = await mcUsdAt(db, sellMcSol, sell.ts, inp.priceOpts);
      if (sellMcUsd != null) mcWeighted += sellMcUsd * sell.tokenAmount;
      const solPriceUsd =
        sellMcUsd != null && sellMcSol != null && sellMcSol > 0 ? sellMcUsd / sellMcSol : null;
      if (solPriceUsd != null) proceedsUsd += sell.solAmount * solPriceUsd;
      else usdOk = false;
    }
    if (soldTokens > 0 && mcWeighted > 0) exitMcUsd = mcWeighted / soldTokens;
    stillHolding = soldTokens < 0.9 * buy.tokenAmount;
    const entrySolPriceUsd =
      entryMcUsd != null && entryMcSol != null && entryMcSol > 0 ? entryMcUsd / entryMcSol : null;
    if (usdOk && entrySolPriceUsd != null) {
      const soldFrac = Math.min(1, soldTokens / buy.tokenAmount);
      realizedPnlUsd = proceedsUsd - buy.solAmount * entrySolPriceUsd * soldFrac;
    }
  }

  await db
    .insert(positions)
    .values({
      wallet: buy.wallet,
      mint: inp.mint,
      firstBuyTs: buy.ts,
      firstBuySlot: buy.slot,
      secondsAfterLaunch: buy.secondsAfterLaunch,
      entryMcUsd,
      entryAmountSol: buy.solAmount,
      tokenAmount: buy.tokenAmount,
      pctOfSupply: (buy.tokenAmount / inp.supply) * 100,
      exitMcUsd,
      realizedPnlUsd,
      stillHolding,
    })
    .onConflictDoUpdate({
      target: [positions.wallet, positions.mint],
      set: {
        firstBuyTs: sql`excluded.first_buy_ts`,
        firstBuySlot: sql`excluded.first_buy_slot`,
        secondsAfterLaunch: sql`excluded.seconds_after_launch`,
        entryMcUsd: sql`excluded.entry_mc_usd`,
        entryAmountSol: sql`excluded.entry_amount_sol`,
        tokenAmount: sql`excluded.token_amount`,
        pctOfSupply: sql`excluded.pct_of_supply`,
        exitMcUsd: sql`coalesce(excluded.exit_mc_usd, ${positions.exitMcUsd})`,
        realizedPnlUsd: sql`coalesce(excluded.realized_pnl_usd, ${positions.realizedPnlUsd})`,
        stillHolding: sql`excluded.still_holding`,
        // creator_linked deliberately untouched — owned by `analyzer funding`
      },
    });

  await db
    .update(wallets)
    .set({ lastActivityTs: sql`greatest(coalesce(${wallets.lastActivityTs}, 'epoch'::timestamptz), ${buy.ts.toISOString()}::timestamptz)` })
    .where(eq(wallets.address, buy.wallet));
}
