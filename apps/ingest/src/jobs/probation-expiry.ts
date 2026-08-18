import { and, eq, sql, wallets } from '@insiderscope/db';
import type { AppCtx } from '../context';
import { invalidateWatchedCache } from '../watched';
import { syncHeliusWebhook } from '../webhook-sync';

/**
 * Hourly sweep: probation wallets that never traded within
 * PROBATION_EXPIRY_DAYS get deactivated and drop off the Helius webhook —
 * rotation tracking must not grow the watch list without bound.
 */
export async function sweepProbation(ctx: AppCtx): Promise<number> {
  const cutoff = new Date(Date.now() - ctx.cfg.PROBATION_EXPIRY_DAYS * 86_400_000);
  const expired = await ctx.db
    .update(wallets)
    .set({ isActive: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(wallets.tier, 'probation'),
        eq(wallets.isActive, true),
        sql`coalesce(${wallets.lastActivityTs}, ${wallets.firstSeen}, 'epoch'::timestamptz) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .returning({ address: wallets.address });

  if (expired.length > 0) {
    invalidateWatchedCache();
    await syncHeliusWebhook(ctx);
    ctx.log(`probation-expiry: deactivated ${expired.length} silent wallet(s)`);
  }
  return expired.length;
}
