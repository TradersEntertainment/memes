import {
  normalizeNativeTransfers,
  normalizeSwap,
  type EnhancedTx,
  type NormalizedSwap,
  type NormalizedTransfer,
} from '@insiderscope/shared';
import type { WatchedWallet } from '../watched';

export type ClassifiedEvent =
  | { kind: 'buy' | 'sell'; wallet: WatchedWallet; swap: NormalizedSwap }
  | { kind: 'transfer_out' | 'transfer_in'; wallet: WatchedWallet; transfer: NormalizedTransfer };

/**
 * Pure classification of one enhanced tx against the watched set.
 * - TRANSFER txs → transfer_out/(transfer_in) above the SOL threshold. Swap txs
 *   never reach this branch, so their internal SOL legs can't fake a rotation.
 * - Everything else is treated as a potential swap when the watched wallet paid
 *   for it (insiders sign their own swaps, so feePayer is the trader).
 */
export function classifyTx(
  tx: EnhancedTx,
  watched: Map<string, WatchedWallet>,
  cfg: { transferMinSol: number },
): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = [];

  if (tx.type === 'TRANSFER') {
    for (const transfer of normalizeNativeTransfers(tx, { minSol: cfg.transferMinSol })) {
      const from = watched.get(transfer.from);
      if (from) events.push({ kind: 'transfer_out', wallet: from, transfer });
      const to = watched.get(transfer.to);
      if (to) events.push({ kind: 'transfer_in', wallet: to, transfer });
    }
    return events;
  }

  const payer = watched.get(tx.feePayer);
  if (!payer) return events;
  const swap = normalizeSwap(tx, { walletHint: tx.feePayer });
  if (swap) {
    const wallet = watched.get(swap.wallet);
    if (wallet) events.push({ kind: swap.direction, wallet, swap });
  }
  return events;
}
