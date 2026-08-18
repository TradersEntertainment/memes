import { WSOL_MINT } from '../constants';
import type { NormalizedSwap, NormalizedTransfer } from '../types';
import { lamportsToSol } from '../utils';
import type { EnhancedTx, SwapTokenEntry } from './types';

function uiFromRaw(entry: SwapTokenEntry): number {
  return Number(entry.rawTokenAmount.tokenAmount) / 10 ** entry.rawTokenAmount.decimals;
}

export interface NormalizeSwapOptions {
  /** Attribute the swap to this wallet when the payload doesn't identify one. */
  walletHint?: string;
  /** Prefer this mint in multi-token / aggregator transactions. */
  mintHint?: string;
}

/**
 * Reduce a Helius enhanced transaction to a single SOL<->token swap, or null when
 * the tx isn't one we can classify (failed, token-to-token, unrelated). Handles
 * both payload shapes: `events.swap` (with raw amounts + WSOL legs) and the
 * pump.fun-style fallback where only tokenTransfers/nativeTransfers exist.
 */
export function normalizeSwap(tx: EnhancedTx, opts: NormalizeSwapOptions = {}): NormalizedSwap | null {
  if (tx.transactionError != null) return null;
  const base = {
    slot: tx.slot,
    ts: new Date(tx.timestamp * 1000),
    signature: tx.signature,
    source: tx.source ?? 'UNKNOWN',
  };

  const swap = tx.events?.swap;
  const hasSwapEvent =
    swap != null &&
    (swap.nativeInput != null ||
      swap.nativeOutput != null ||
      (swap.tokenInputs?.length ?? 0) > 0 ||
      (swap.tokenOutputs?.length ?? 0) > 0);

  if (hasSwapEvent) {
    const wallet =
      swap.nativeInput?.account ?? swap.nativeOutput?.account ?? opts.walletHint ?? tx.feePayer;
    const tokenIn = (swap.tokenInputs ?? []).filter((e) => e.mint !== WSOL_MINT);
    const tokenOut = (swap.tokenOutputs ?? []).filter((e) => e.mint !== WSOL_MINT);
    const wsolIn = (swap.tokenInputs ?? [])
      .filter((e) => e.mint === WSOL_MINT)
      .reduce((s, e) => s + uiFromRaw(e), 0);
    const wsolOut = (swap.tokenOutputs ?? [])
      .filter((e) => e.mint === WSOL_MINT)
      .reduce((s, e) => s + uiFromRaw(e), 0);
    const solIn = (swap.nativeInput ? lamportsToSol(swap.nativeInput.amount) : 0) + wsolIn;
    const solOut = (swap.nativeOutput ? lamportsToSol(swap.nativeOutput.amount) : 0) + wsolOut;

    const pick = (entries: SwapTokenEntry[]): SwapTokenEntry | null => {
      if (entries.length === 0) return null;
      if (opts.mintHint) return entries.find((e) => e.mint === opts.mintHint) ?? null;
      return entries.reduce((best, e) => (uiFromRaw(e) > uiFromRaw(best) ? e : best));
    };

    const bought = pick(tokenOut);
    if (solIn > 0 && bought) {
      const tokenAmount = uiFromRaw(bought);
      if (tokenAmount > 0) {
        return { ...base, wallet, mint: bought.mint, direction: 'buy', solAmount: solIn, tokenAmount };
      }
    }
    const sold = pick(tokenIn);
    if (solOut > 0 && sold) {
      const tokenAmount = uiFromRaw(sold);
      if (tokenAmount > 0) {
        return { ...base, wallet, mint: sold.mint, direction: 'sell', solAmount: solOut, tokenAmount };
      }
    }
    return null; // token-to-token or unresolvable
  }

  // Fallback: net token + SOL flows for the wallet of interest.
  const wallet = opts.walletHint ?? tx.feePayer;
  if (!wallet) return null;

  const tokenNet = new Map<string, number>();
  let solNet = 0;
  for (const t of tx.tokenTransfers ?? []) {
    const amount = t.tokenAmount ?? 0;
    if (amount <= 0) continue;
    if (t.mint === WSOL_MINT) {
      if (t.toUserAccount === wallet) solNet += amount;
      if (t.fromUserAccount === wallet) solNet -= amount;
      continue;
    }
    if (t.toUserAccount === wallet) tokenNet.set(t.mint, (tokenNet.get(t.mint) ?? 0) + amount);
    if (t.fromUserAccount === wallet) tokenNet.set(t.mint, (tokenNet.get(t.mint) ?? 0) - amount);
  }
  for (const n of tx.nativeTransfers ?? []) {
    if (n.toUserAccount === wallet) solNet += lamportsToSol(n.amount);
    if (n.fromUserAccount === wallet) solNet -= lamportsToSol(n.amount);
  }

  if (tokenNet.size === 0) return null;
  let mint: string | null = null;
  if (opts.mintHint && tokenNet.has(opts.mintHint)) {
    mint = opts.mintHint;
  } else {
    let bestAbs = 0;
    for (const [m, v] of tokenNet) {
      if (Math.abs(v) > bestAbs) {
        bestAbs = Math.abs(v);
        mint = m;
      }
    }
  }
  if (!mint) return null;
  const net = tokenNet.get(mint)!;
  if (net > 0 && solNet < 0) {
    return { ...base, wallet, mint, direction: 'buy', solAmount: -solNet, tokenAmount: net };
  }
  if (net < 0 && solNet > 0) {
    return { ...base, wallet, mint, direction: 'sell', solAmount: solNet, tokenAmount: -net };
  }
  return null;
}

/**
 * Extract native SOL transfers, aggregated per (from, to) pair so one row matches
 * one edge even when a tx splits an amount across several transfer instructions.
 */
export function normalizeNativeTransfers(
  tx: EnhancedTx,
  opts: { minSol?: number } = {},
): NormalizedTransfer[] {
  if (tx.transactionError != null) return [];
  const minSol = opts.minSol ?? 0;
  const agg = new Map<string, { from: string; to: string; amountSol: number }>();
  for (const n of tx.nativeTransfers ?? []) {
    if (!n.fromUserAccount || !n.toUserAccount || n.fromUserAccount === n.toUserAccount) continue;
    const sol = lamportsToSol(n.amount);
    if (sol <= 0) continue;
    const key = `${n.fromUserAccount}|${n.toUserAccount}`;
    const cur = agg.get(key);
    if (cur) cur.amountSol += sol;
    else agg.set(key, { from: n.fromUserAccount, to: n.toUserAccount, amountSol: sol });
  }
  return [...agg.values()]
    .filter((t) => t.amountSol >= minSol)
    .map((t) => ({
      ...t,
      ts: new Date(tx.timestamp * 1000),
      slot: tx.slot,
      signature: tx.signature,
    }));
}
