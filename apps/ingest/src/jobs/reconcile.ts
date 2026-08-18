import { and, eq, inArray, wallets } from '@insiderscope/db';
import { shortAddr } from '@insiderscope/shared';
import type { AppCtx } from '../context';
import { processTx } from '../pipeline/process';

/**
 * The webhook's safety net (every RECONCILE_INTERVAL_MIN): for each active
 * watched wallet, fetch txs since its last processed signature and push them
 * through the exact same pipeline. Missed webhook deliveries surface here;
 * duplicates die on the composite unique. Stale events are recorded but the
 * age gate keeps them from alerting.
 */
export async function reconcile(ctx: AppCtx): Promise<void> {
  if (!ctx.helius) return;
  const rows = await ctx.db
    .select({ address: wallets.address, lastSig: wallets.lastSig })
    .from(wallets)
    .where(
      and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch', 'probation'])),
    );

  let processed = 0;
  for (const w of rows) {
    try {
      const first = await ctx.helius.getParsedTransactions(w.address, {
        until: w.lastSig ?? undefined,
        limit: 100,
      });
      if (first.length === 0) continue;
      let batch = first;
      if (first.length === 100) {
        // one extra page covers bursts; anything older waits for the next tick
        const more = await ctx.helius.getParsedTransactions(w.address, {
          until: w.lastSig ?? undefined,
          before: first[first.length - 1]!.signature,
          limit: 100,
        });
        batch = [...first, ...more];
      }
      for (const tx of [...batch].reverse()) {
        await processTx(ctx.pipeline, tx, 'reconcile');
      }
      // advance the cursor even when nothing classified, so unrelated txs
      // aren't refetched forever
      await ctx.db
        .update(wallets)
        .set({ lastSig: first[0]!.signature })
        .where(eq(wallets.address, w.address));
      processed += batch.length;
    } catch (err) {
      ctx.log(`reconcile ${shortAddr(w.address)} failed: ${err}`);
    }
  }
  if (processed > 0) ctx.log(`reconcile: processed ${processed} tx(s) across ${rows.length} wallet(s)`);
}
