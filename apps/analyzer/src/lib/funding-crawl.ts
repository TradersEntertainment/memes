import { eq, inArray, or, sql, transfers } from '@insiderscope/db';
import { chunk, normalizeNativeTransfers } from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';

const MIN_EDGE_SOL = 0.01;

/**
 * Crawl a wallet's native SOL transfers (last `days`, page-capped) into the
 * transfers table. Idempotent via the (signature, from, to) composite unique.
 */
export async function crawlTransfers(
  ctx: AnalyzerCtx,
  wallet: string,
  opts: { days?: number; maxPages?: number } = {},
): Promise<number> {
  const days = opts.days ?? 90;
  const maxPages = opts.maxPages ?? ctx.cfg.HELIUS_MAX_PAGES_WALLET;
  const cutoff = Date.now() / 1000 - days * 86400;

  const rows: { fromWallet: string; toWallet: string; amountSol: number; ts: Date; signature: string }[] = [];
  outer: for await (const page of ctx.helius.iterateHistory(wallet, {
    type: 'TRANSFER',
    maxPages,
  })) {
    for (const tx of page) {
      if (tx.timestamp < cutoff) break outer; // newest→oldest: past the window, stop
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
  }

  for (const group of chunk(rows, 500)) {
    if (group.length > 0) {
      await ctx.db.insert(transfers).values(group).onConflictDoNothing();
    }
  }
  return rows.length;
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
