/**
 * Structural types for the Helius Enhanced Transactions API — only the fields we
 * actually read. Payload variance is expected (pump.fun swaps often lack
 * `events.swap`); every consumer must go through normalize.ts, which owns all
 * unit conversions:
 *   - nativeTransfers[].amount        → integer LAMPORTS
 *   - tokenTransfers[].tokenAmount    → decimal UI amount
 *   - events.swap rawTokenAmount      → raw string + decimals
 *   - events.swap nativeInput/Output  → lamports as a string
 */

export interface EnhancedNativeTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  /** Lamports. */
  amount: number;
}

export interface EnhancedTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  mint: string;
  /** UI units (decimals already applied). */
  tokenAmount: number;
  tokenStandard?: string;
}

export interface SwapRawTokenAmount {
  /** Raw integer amount as a string. */
  tokenAmount: string;
  decimals: number;
}

export interface SwapTokenEntry {
  userAccount?: string | null;
  tokenAccount?: string | null;
  mint: string;
  rawTokenAmount: SwapRawTokenAmount;
}

export interface SwapNativeEntry {
  account: string;
  /** Lamports as a string. */
  amount: string;
}

export interface EnhancedSwapEvent {
  nativeInput?: SwapNativeEntry | null;
  nativeOutput?: SwapNativeEntry | null;
  tokenInputs?: SwapTokenEntry[] | null;
  tokenOutputs?: SwapTokenEntry[] | null;
  tokenFees?: SwapTokenEntry[] | null;
  nativeFees?: SwapNativeEntry[] | null;
  innerSwaps?: unknown[];
}

export interface EnhancedInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
  innerInstructions?: { programId: string }[];
}

export interface EnhancedTx {
  signature: string;
  /** Unix seconds. */
  timestamp: number;
  slot: number;
  type: string;
  source: string;
  feePayer: string;
  fee?: number;
  description?: string;
  transactionError?: unknown;
  nativeTransfers?: EnhancedNativeTransfer[] | null;
  tokenTransfers?: EnhancedTokenTransfer[] | null;
  events?: { swap?: EnhancedSwapEvent | null } | null;
  instructions?: EnhancedInstruction[] | null;
}
