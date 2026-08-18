import { eq, positions, sql, tokens, wallets, type Db } from '@insiderscope/db';
import {
  deriveBondingCurvePda,
  ensureSolPriceRange,
  getLiveMcFromDexscreener,
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

export async function runEarlyBuyersAll(ctx: AnalyzerCtx): Promise<void> {
  const candidates = await ctx.db
    .select({ mint: tokens.mint })
    .from(tokens)
    .where(eq(tokens.status, 'candidate'));
  ctx.log(`early-buyers: ${candidates.length} candidate token(s)`);
  for (const { mint } of candidates) {
    await runEarlyBuyers(ctx, mint);
  }
}

export async function runEarlyBuyers(ctx: AnalyzerCtx, mint: string): Promise<void> {
  const { db, cfg, log } = ctx;
  await upsertToken(db, { mint, status: 'candidate' });

  // Crawl the bounded address: pump.fun bonding curve first, AMM pool as fallback.
  // Never the mint itself — a $10M token's mint history is millions of txs.
  const curve = deriveBondingCurvePda(mint);
  let crawlAddress = curve;
  let txs = await ctx.helius.fetchHistoryOldestFirst(curve, {
    maxPages: cfg.HELIUS_MAX_PAGES_TOKEN,
  });

  if (txs.length === 0) {
    const existing = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
    let pool = existing[0]?.poolAddress ?? null;
    if (!pool) {
      const live = await getLiveMcFromDexscreener(mint);
      pool = live?.pair.pairAddress ?? null;
    }
    if (pool) {
      log(`${mint}: empty bonding curve history, crawling pool ${pool}`);
      crawlAddress = pool;
      txs = await ctx.helius.fetchHistoryOldestFirst(pool, {
        maxPages: cfg.HELIUS_MAX_PAGES_TOKEN,
      });
    }
  }

  if (txs.length === 0) {
    log(`${mint}: no crawlable history (bonding curve empty, no pool found) — skipped`);
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
