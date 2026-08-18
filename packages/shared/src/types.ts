export type SwapDirection = 'buy' | 'sell';

/** A parsed swap reduced to what the whole system operates on. */
export interface NormalizedSwap {
  wallet: string;
  mint: string;
  direction: SwapDirection;
  solAmount: number;
  /** UI units (decimals applied). */
  tokenAmount: number;
  slot: number;
  ts: Date;
  signature: string;
  source: string;
}

export interface NormalizedTransfer {
  from: string;
  to: string;
  amountSol: number;
  ts: Date;
  slot: number;
  signature: string;
}

export type LaunchPlatform = 'pumpfun' | 'raydium' | 'other';

export interface LaunchInfo {
  platform: LaunchPlatform;
  launchTs: Date;
  launchSlot: number;
  creator: string;
}
