import { normalizeSwap, QUOTE_MINTS } from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';

export interface MintAggregate {
  buySol: number;
  buyTokens: number;
  sellSol: number;
  sellTokens: number;
  firstBuyTs: Date | null;
  firstBuySlot: number | null;
  sellEvents: { sol: number; ts: Date }[];
  buyEvents: { sol: number; ts: Date }[];
}

export interface WalletSwapAggregates {
  totalTrades: number;
  /** True when the page cap was hit — totalTrades is a lower bound. */
  truncated: boolean;
  perMint: Map<string, MintAggregate>;
  oldestTs: Date | null;
  newestTs: Date | null;
}

/**
 * The survivorship-bias countermeasure: pull the wallet's COMPLETE swap history
 * (page-capped) so scoring sees every token it touched — losers included — not
 * just the winners that got the wallet noticed.
 */
export async function fetchWalletSwapAggregates(
  ctx: AnalyzerCtx,
  wallet: string,
): Promise<WalletSwapAggregates> {
  const perMint = new Map<string, MintAggregate>();
  let totalTrades = 0;
  let pages = 0;
  let oldestTs: Date | null = null;
  let newestTs: Date | null = null;
  const maxPages = ctx.cfg.HELIUS_MAX_PAGES_WALLET;

  for await (const page of ctx.helius.iterateHistory(wallet, { type: 'SWAP', maxPages })) {
    pages += 1;
    for (const tx of page) {
      const swap = normalizeSwap(tx, { walletHint: wallet });
      if (!swap || swap.wallet !== wallet) continue;
      // SOL↔stable conversions are portfolio management, not trades — counting
      // them would inflate totalTrades and poison the selectivity/bot checks.
      if (QUOTE_MINTS.has(swap.mint)) continue;
      totalTrades += 1;
      if (!newestTs || swap.ts > newestTs) newestTs = swap.ts;
      if (!oldestTs || swap.ts < oldestTs) oldestTs = swap.ts;

      const agg = perMint.get(swap.mint) ?? {
        buySol: 0,
        buyTokens: 0,
        sellSol: 0,
        sellTokens: 0,
        firstBuyTs: null,
        firstBuySlot: null,
        sellEvents: [],
        buyEvents: [],
      };
      if (swap.direction === 'buy') {
        agg.buySol += swap.solAmount;
        agg.buyTokens += swap.tokenAmount;
        agg.buyEvents.push({ sol: swap.solAmount, ts: swap.ts });
        // history iterates newest→oldest, so keep overwriting to end at the first buy
        agg.firstBuyTs = swap.ts;
        agg.firstBuySlot = swap.slot;
      } else {
        agg.sellSol += swap.solAmount;
        agg.sellTokens += swap.tokenAmount;
        agg.sellEvents.push({ sol: swap.solAmount, ts: swap.ts });
      }
      perMint.set(swap.mint, agg);
    }
  }

  return { totalTrades, truncated: pages >= maxPages, perMint, oldestTs, newestTs };
}
