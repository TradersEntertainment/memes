import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { PUMPFUN_PROGRAM_ID, PUMPFUN_TOTAL_SUPPLY } from './constants';

/**
 * The pump.fun bonding curve PDA for a mint. Its transaction history is bounded
 * (bonding phase only), which is what makes historical early-buyer crawls cheap —
 * crawl this address, never the mint.
 */
export function deriveBondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMPFUN_PROGRAM_ID),
  );
  return pda.toBase58();
}

/** Market cap in SOL from bonding curve virtual reserves (price × 1B supply). */
export function pumpfunMcSol(vSolInCurve: number, vTokensInCurve: number): number {
  if (vTokensInCurve <= 0) return 0;
  return (vSolInCurve / vTokensInCurve) * PUMPFUN_TOTAL_SUPPLY;
}
