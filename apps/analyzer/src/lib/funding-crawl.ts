import { eq, inArray, or, sql, transfers } from '@insiderscope/db';
import { chunk, normalizeNativeTransfers } from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';

const MIN_EDGE_SOL = 0.01;

export interface CrawlTransfersResult {
  rows: number;
  /** False when the page cap stopped the crawl before it reached `since`. */
  reachedWindow: boolean;
}

/**
 * Crawl a wallet's native SOL transfers back to `since` into the transfers table.
 * Idempotent via the (signature, from, to) composite unique.
 *
 * `since` matters: a dev funds their bundle wallets AROUND THE LAUNCH, so for a
 * token that launched two years ago a "last 90 days" window contains none of the
 * evidence. Callers anchor the window to the token's launch date.
 */
export async function crawlTransfers(
  ctx: AnalyzerCtx,
  wallet: string,
  opts: { since?: Date; days?: number; maxPages?: number } = {},
): Promise<CrawlTransfersResult> {
  const maxPages = opts.maxPages ?? ctx.cfg.HELIUS_MAX_PAGES_WALLET;
  const cutoff = opts.since
    ? opts.since.getTime() / 1000
    : Date.now() / 1000 - (opts.days ?? 90) * 86400;

  const rows: { fromWallet: string; toWallet: string; amountSol: number; ts: Date; signature: string }[] = [];
  let reachedWindow = false;
  let pages = 0;
  outer: for await (const page of ctx.helius.iterateHistory(wallet, {
    type: 'TRANSFER',
    maxPages,
  })) {
    pages += 1;
    for (const tx of page) {
      if (tx.timestamp < cutoff) {
        reachedWindow = true;
        break outer; // newest→oldest: past the window, stop
      }
      for (const t of normalizeNativeTransfers(tx, { minSol: MIN_EDGE_SOL })) {
        if (t.from !== wallet && t.to !== wallet) continue;
        rows.push({
          fromWallet: t.from,
          toWallet: t.to,
          amountSol: t.amountSol,
          ts: t.ts,
          signature: t.signature,
        });
      }
    }
    if (pages < maxPages && page.length < 100) reachedWindow = true; // history exhausted
  }

  for (const group of chunk(rows, 500)) {
    if (group.length > 0) {
      await ctx.db.insert(transfers).values(group).onConflictDoNothing();
    }
  }
  return { rows: rows.length, reachedWindow };
}

export async function hasTransfersFor(ctx: AnalyzerCtx, wallet: string): Promise<boolean> {
  const found = await ctx.db
    .select({ one: sql<number>`1` })
    .from(transfers)
    .where(or(eq(transfers.fromWallet, wallet), eq(transfers.toWallet, wallet)))
    .limit(1);
  return found.length > 0;
}

/** All stored edges touching any wallet in the set (both directions). */
export async function loadEdgesTouching(
  ctx: AnalyzerCtx,
  addresses: string[],
): Promise<{ from: string; to: string; amountSol: number }[]> {
  const unique = [...new Set(addresses)];
  const out: { from: string; to: string; amountSol: number }[] = [];
  for (const group of chunk(unique, 200)) {
    const rows = await ctx.db
      .select({
        from: transfers.fromWallet,
        to: transfers.toWallet,
        amountSol: transfers.amountSol,
      })
      .from(transfers)
      .where(or(inArray(transfers.fromWallet, group), inArray(transfers.toWallet, group)));
    out.push(...rows);
  }
  return out;
}
