import type { Db } from '@insiderscope/db';
import { getSolPriceUsdAt, type SolPriceOptions } from './sol-price';

/**
 * Market cap in SOL implied by a swap itself: price = SOL paid / tokens received,
 * MC = price × total supply. This is the only way to get historical entry MCs —
 * DexScreener has no history — and doubles as the live fallback for tokens too
 * new to be listed anywhere.
 */
export function swapDerivedMcSol(
  solAmount: number,
  tokenAmountUi: number,
  totalSupplyUi: number,
): number | null {
  if (solAmount <= 0 || tokenAmountUi <= 0 || totalSupplyUi <= 0) return null;
  return (solAmount / tokenAmountUi) * totalSupplyUi;
}

/** Convert a SOL-denominated MC to USD using the cached historical SOL price. */
export async function mcUsdAt(
  db: Db,
  mcSol: number | null,
  ts: Date,
  opts: SolPriceOptions = {},
): Promise<number | null> {
  if (mcSol == null || mcSol <= 0) return null;
  const price = await getSolPriceUsdAt(db, ts, opts);
  return price != null ? mcSol * price : null;
}
