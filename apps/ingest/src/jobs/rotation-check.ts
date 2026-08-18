import { eq, wallets } from '@insiderscope/db';
import { isCexWallet, normalizeNativeTransfers, shortAddr } from '@insiderscope/shared';
import type { AppCtx } from '../context';
import type { RotationCheckJobData } from '../pipeline/rotation';
import { invalidateWatchedCache } from '../watched';
import { syncHeliusWebhook } from '../webhook-sync';

/**
 * Runs ~5 minutes after a rotation was tracked. CEX deposit-address heuristic:
 * a fresh account that forwarded ≥90% of the SOL it received straight to a
 * known exchange hot wallet is a deposit address, not a trading wallet —
 * blacklist it silently. Real rotation targets get registered with Helius and
 * announced (rotation alerts are intentionally ~5 min delayed; buy alerts on
 * the new wallet stay real-time once it's registered).
 */
export async function runRotationCheck(ctx: AppCtx, data: RotationCheckJobData): Promise<void> {
  const { target, parent, amountSol } = data;
  const row = (await ctx.db.select().from(wallets).where(eq(wallets.address, target)).limit(1))[0];
  if (!row || row.tier !== 'probation' || !row.isActive) return;

  let isCexDeposit = false;
  if (ctx.helius) {
    const txs = await ctx.helius.getParsedTransactions(target, { limit: 100 }).catch(() => []);
    let receivedSol = 0;
    let forwardedToCexSol = 0;
    for (const tx of txs) {
      for (const t of normalizeNativeTransfers(tx)) {
        if (t.to === target) receivedSol += t.amountSol;
        if (t.from === target && isCexWallet(t.to)) forwardedToCexSol += t.amountSol;
      }
    }
    isCexDeposit = forwardedToCexSol > 0 && forwardedToCexSol >= 0.9 * receivedSol;
  }

  if (isCexDeposit) {
    await ctx.db
      .update(wallets)
      .set({ tier: 'blacklist', isActive: false, label: row.label ?? 'cex-deposit' })
      .where(eq(wallets.address, target));
    invalidateWatchedCache();
    ctx.log(
      `rotation-check: ${shortAddr(target)} forwards to a CEX (deposit address) — blacklisted, no alert`,
    );
    return;
  }

  await syncHeliusWebhook(ctx);
  const parentRow = (
    await ctx.db.select().from(wallets).where(eq(wallets.address, parent)).limit(1)
  )[0];
  await ctx.alertsQueue.add('rotation', {
    rotation: {
      parent: {
        address: parent,
        label: parentRow?.label ?? null,
        score: parentRow?.insiderScore ?? null,
        bigTokenCount: parentRow?.scoreBreakdown?.bigTokenCount ?? null,
      },
      child: target,
      amountSol,
    },
  });
  ctx.log(`rotation-check: ${shortAddr(target)} looks real — registered + alert queued`);
}
