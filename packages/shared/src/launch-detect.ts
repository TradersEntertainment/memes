import { PUMPFUN_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID } from './constants';
import type { EnhancedTx } from './helius/types';
import type { LaunchInfo } from './types';

export function txHasProgram(tx: EnhancedTx, programId: string): boolean {
  for (const ins of tx.instructions ?? []) {
    if (ins.programId === programId) return true;
    for (const inner of ins.innerInstructions ?? []) {
      if (inner.programId === programId) return true;
    }
  }
  return false;
}

/**
 * Determine the launch moment from an address's oldest-first history.
 * pump.fun: the CREATE tx. Raydium: the pool-creating tx. Fallback: the crawled
 * address is the bonding curve / pool itself, so its very first successful tx IS
 * the launch and its feePayer the creator.
 */
export function detectLaunch(txsOldestFirst: EnhancedTx[]): LaunchInfo | null {
  const ordered = txsOldestFirst.filter((t) => t.transactionError == null);
  const first = ordered[0];
  if (!first) return null;

  const pumpCreate = ordered.find(
    (t) =>
      (t.type === 'CREATE' || t.type === 'TOKEN_MINT') &&
      (t.source === 'PUMP_FUN' || txHasProgram(t, PUMPFUN_PROGRAM_ID)),
  );
  if (pumpCreate) {
    return {
      platform: 'pumpfun',
      launchTs: new Date(pumpCreate.timestamp * 1000),
      launchSlot: pumpCreate.slot,
      creator: pumpCreate.feePayer,
    };
  }

  const isRaydium =
    first.type === 'CREATE_POOL' ||
    first.source === 'RAYDIUM' ||
    txHasProgram(first, RAYDIUM_AMM_V4_PROGRAM_ID);
  return {
    platform: isRaydium ? 'raydium' : 'other',
    launchTs: new Date(first.timestamp * 1000),
    launchSlot: first.slot,
    creator: first.feePayer,
  };
}
