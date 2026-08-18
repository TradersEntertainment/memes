import { and, count, eq, wallets, type Db } from '@insiderscope/db';
import { isCexWallet, shortAddr, type AppConfig } from '@insiderscope/shared';
import { invalidateWatchedCache } from '../watched';
import type { RotationInput } from './process';

export interface RotationCheckJobData {
  target: string;
  parent: string;
  amountSol: number;
  signature: string;
}

export interface RotationDeps {
  db: Db;
  cfg: AppConfig;
  log: (msg: string) => void;
  /** Enqueue the delayed CEX-deposit check (Task: jobs/rotation-check). */
  scheduleRotationCheck: (data: RotationCheckJobData, delayMs: number) => Promise<void>;
}

/**
 * A watched wallet moved ≥ TRANSFER_MIN_SOL to an unknown address. Track the
 * target as a probation wallet, but don't alert or register it with Helius yet:
 * a delayed job first checks whether the target is a CEX deposit address (fresh
 * account that immediately forwards to a known exchange). Guards: static CEX
 * list, already-known wallets, and a max-children-per-parent cap so one insider
 * can't flood the watch list.
 */
export async function handleTransferOut(deps: RotationDeps, input: RotationInput): Promise<void> {
  const { db, cfg, log } = deps;
  const target = input.target;

  if (isCexWallet(target)) {
    log(`rotation: ${shortAddr(input.parent.address)} → ${shortAddr(target)} is a known CEX, ignored`);
    return;
  }
  const existing = await db
    .select({ address: wallets.address })
    .from(wallets)
    .where(eq(wallets.address, target))
    .limit(1);
  if (existing.length > 0) return; // already tracked (any tier) — nothing to do

  const children = await db
    .select({ n: count() })
    .from(wallets)
    .where(and(eq(wallets.parentWallet, input.parent.address), eq(wallets.isActive, true)));
  if ((children[0]?.n ?? 0) >= cfg.MAX_CHILDREN_PER_PARENT) {
    log(
      `rotation: ${shortAddr(input.parent.address)} already has ${children[0]!.n} active children — cap ${cfg.MAX_CHILDREN_PER_PARENT}, target ${shortAddr(target)} not tracked`,
    );
    return;
  }

  await db
    .insert(wallets)
    .values({
      address: target,
      tier: 'probation',
      parentWallet: input.parent.address,
      firstSeen: new Date(),
      isActive: true,
    })
    .onConflictDoNothing();
  invalidateWatchedCache();

  await deps.scheduleRotationCheck(
    {
      target,
      parent: input.parent.address,
      amountSol: input.amountSol,
      signature: input.signature,
    },
    5 * 60_000,
  );
  log(
    `rotation: ${shortAddr(input.parent.address)} → ${shortAddr(target)} (${input.amountSol} SOL), probation + CEX-deposit check in 5m`,
  );
}
