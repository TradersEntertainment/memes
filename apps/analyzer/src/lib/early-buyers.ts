import {
  normalizeSwap,
  SLOT_MS,
  type EnhancedTx,
  type LaunchInfo,
  type NormalizedSwap,
} from '@insiderscope/shared';

export interface EarlyBuy extends NormalizedSwap {
  secondsAfterLaunch: number;
}

export interface EarlyBuyersCfg {
  mint: string;
  windowSec: number;
  maxBuyers: number;
}

/**
 * Entry timing prefers slot deltas (400ms granularity — the <3s sniper rule needs
 * sub-second resolution) and falls back to block timestamps.
 */
export function secondsAfterLaunch(
  swap: { slot: number; ts: Date },
  launch: LaunchInfo,
): number {
  if (swap.slot > 0 && launch.launchSlot > 0) {
    return ((swap.slot - launch.launchSlot) * SLOT_MS) / 1000;
  }
  return (swap.ts.getTime() - launch.launchTs.getTime()) / 1000;
}

/**
 * Walk a token's oldest-first history and collect its early buyers:
 * - only each wallet's FIRST buy counts (re-buys don't create new entries)
 * - stop admitting new buyers after `windowSec` or `maxBuyers`
 * - keep collecting sells by known early buyers through the whole crawled range,
 *   so exit PnL sees dumps that happened after the entry window closed
 */
export function extractEarlyBuyers(
  txsOldestFirst: EnhancedTx[],
  launch: LaunchInfo,
  cfg: EarlyBuyersCfg,
): { buys: EarlyBuy[]; sells: NormalizedSwap[] } {
  const buyers = new Map<string, EarlyBuy>();
  const sells: NormalizedSwap[] = [];

  for (const tx of txsOldestFirst) {
    const swap = normalizeSwap(tx, { mintHint: cfg.mint });
    if (!swap) continue;

    if (swap.direction === 'buy') {
      if (buyers.has(swap.wallet)) continue;
      const seconds = secondsAfterLaunch(swap, launch);
      if (seconds < 0) continue;
      if (seconds > cfg.windowSec || buyers.size >= cfg.maxBuyers) continue;
      buyers.set(swap.wallet, { ...swap, secondsAfterLaunch: seconds });
    } else if (buyers.has(swap.wallet)) {
      sells.push(swap);
    }
  }

  return { buys: [...buyers.values()], sells };
}
