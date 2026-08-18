import { eq, liveEvents, sql, wallets, type Db } from '@insiderscope/db';
import type { AppConfig, EnhancedTx, NormalizedSwap } from '@insiderscope/shared';
import type { WatchedWallet } from '../watched';
import { classifyTx, type ClassifiedEvent } from './classify';

export interface RotationInput {
  parent: WatchedWallet;
  target: string;
  amountSol: number;
  signature: string;
}

/**
 * Everything the pipeline touches in the outside world, injectable so tests run
 * it against a real Postgres with fakes for redis/queues/telegram.
 */
export interface PipelineDeps {
  db: Db;
  cfg: AppConfig;
  getWatched: () => Promise<Map<string, WatchedWallet>>;
  /** SET NX EX — returns true when this key was acquired (i.e. not a duplicate). */
  debounce: (key: string, ttlSec: number) => Promise<boolean>;
  enqueueAlert: (eventId: number) => Promise<void>;
  resolveMc: (
    mint: string,
    swap: NormalizedSwap,
  ) => Promise<{ mcUsd: number | null; source: string }>;
  onTransferOut: (input: RotationInput) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Idempotent event pipeline shared by the webhook and the reconciliation job.
 * Replays die on the live_events (signature, wallet, event_type) unique — no
 * insert, no side effects.
 */
export async function processTx(
  deps: PipelineDeps,
  tx: EnhancedTx,
  origin: 'webhook' | 'reconcile',
): Promise<void> {
  const watched = await deps.getWatched();
  const events = classifyTx(tx, watched, { transferMinSol: deps.cfg.TRANSFER_MIN_SOL });
  for (const ev of events) {
    await handleEvent(deps, ev, origin);
  }
}

async function handleEvent(
  deps: PipelineDeps,
  ev: ClassifiedEvent,
  origin: 'webhook' | 'reconcile',
): Promise<void> {
  const base =
    'swap' in ev
      ? {
          mint: ev.swap.mint,
          amountSol: ev.swap.solAmount,
          tokenAmount: ev.swap.tokenAmount,
          counterparty: null,
          ts: ev.swap.ts,
          signature: ev.swap.signature,
        }
      : {
          mint: null,
          amountSol: ev.transfer.amountSol,
          tokenAmount: null,
          counterparty: ev.kind === 'transfer_out' ? ev.transfer.to : ev.transfer.from,
          ts: ev.transfer.ts,
          signature: ev.transfer.signature,
        };
  const { ts, signature } = base;

  const inserted = await deps.db
    .insert(liveEvents)
    .values({ wallet: ev.wallet.address, eventType: ev.kind, ...base })
    .onConflictDoNothing()
    .returning({ id: liveEvents.id });
  const row = inserted[0];
  if (!row) return; // replay — already processed

  await deps.db
    .update(wallets)
    .set({ lastSig: signature, lastActivityTs: ts, updatedAt: sql`now()` })
    .where(eq(wallets.address, ev.wallet.address));

  if ('swap' in ev) {
    const mc = await deps.resolveMc(ev.swap.mint, ev.swap);
    if (mc.mcUsd != null) {
      await deps.db
        .update(liveEvents)
        .set({ mcAtEvent: mc.mcUsd })
        .where(eq(liveEvents.id, row.id));
    }

    const ageMin = (Date.now() - ts.getTime()) / 60_000;
    const alertable =
      !ev.wallet.muted &&
      ev.wallet.tier !== 'blacklist' &&
      (ev.kind === 'buy' || deps.cfg.SELL_ALERTS) &&
      ageMin <= deps.cfg.ALERT_MAX_AGE_MIN;
    if (alertable) {
      const key = `is:debounce:${ev.wallet.address}:${ev.swap.mint}:${ev.kind}`;
      if (await deps.debounce(key, deps.cfg.ALERT_DEBOUNCE_SEC)) {
        await deps.enqueueAlert(row.id);
      }
    }
    deps.log(
      `${origin} ${ev.kind}: ${ev.wallet.address.slice(0, 6)}… ${ev.swap.solAmount} SOL ${ev.swap.mint.slice(0, 6)}… mc=${mc.mcUsd ?? '?'} (${mc.source})${alertable ? '' : ' [no-alert]'}`,
    );
  } else if (ev.kind === 'transfer_out') {
    await deps.onTransferOut({
      parent: ev.wallet,
      target: ev.transfer.to,
      amountSol: ev.transfer.amountSol,
      signature,
    });
  }
}
