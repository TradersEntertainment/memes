import { describe, expect, it } from 'vitest';
import { normalizeNativeTransfers, normalizeSwap } from '../src/helius/normalize';
import type { EnhancedTx } from '../src/helius/types';
import { FIX, loadFixture } from './fixtures';

describe('normalizeSwap', () => {
  it('parses an events.swap buy with nativeInput (raw amounts → UI units)', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-buy-events.json');
    const swap = normalizeSwap(tx);
    expect(swap).toEqual({
      wallet: FIX.buyer1,
      mint: FIX.mint,
      direction: 'buy',
      solAmount: 2.5,
      tokenAmount: 12_500_000,
      slot: 362000600,
      ts: new Date(1755500240 * 1000),
      signature: tx.signature,
      source: 'RAYDIUM',
    });
  });

  it('parses an events.swap sell with nativeOutput', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-sell-events.json');
    const swap = normalizeSwap(tx);
    expect(swap?.direction).toBe('sell');
    expect(swap?.wallet).toBe(FIX.buyer1);
    expect(swap?.solAmount).toBe(1.8);
    expect(swap?.tokenAmount).toBe(9_000_000);
  });

  it('treats WSOL token legs as SOL (Raydium/Jupiter routed swaps)', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-raydium-wsol.json');
    const swap = normalizeSwap(tx);
    expect(swap?.direction).toBe('buy');
    expect(swap?.wallet).toBe(FIX.buyer2);
    expect(swap?.solAmount).toBe(3);
    expect(swap?.tokenAmount).toBe(1_000_000);
    expect(swap?.mint).toBe(FIX.mint);
  });

  it('falls back to net token/native flows when events.swap is missing (pump.fun)', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-pumpfun-fallback.json');
    const swap = normalizeSwap(tx);
    expect(swap?.direction).toBe('buy');
    expect(swap?.wallet).toBe(FIX.buyer3);
    // 1 SOL to the curve + 0.01 SOL fee, both leave the buyer
    expect(swap?.solAmount).toBeCloseTo(1.01, 9);
    expect(swap?.tokenAmount).toBeCloseTo(35_714_285.71, 2);
  });

  it('classifies the initial dev buy inside a pump.fun CREATE tx via mintHint', () => {
    const tx = loadFixture<EnhancedTx>('helius/pumpfun-create.json');
    const swap = normalizeSwap(tx, { mintHint: FIX.mint });
    expect(swap?.direction).toBe('buy');
    expect(swap?.wallet).toBe(FIX.creator);
    expect(swap?.solAmount).toBe(2);
    expect(swap?.tokenAmount).toBe(60_000_000);
  });

  it('returns null for failed transactions', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-buy-events.json');
    expect(normalizeSwap({ ...tx, transactionError: { err: 'x' } })).toBeNull();
  });

  it('returns null when mintHint does not match the swapped token', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-buy-events.json');
    expect(normalizeSwap(tx, { mintHint: 'SomeOtherMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).toBeNull();
  });

  it('returns null for a plain transfer (no token flows)', () => {
    const tx = loadFixture<EnhancedTx>('helius/transfer-native.json');
    expect(normalizeSwap(tx)).toBeNull();
  });
});

describe('normalizeNativeTransfers', () => {
  it('extracts a native transfer in SOL units', () => {
    const tx = loadFixture<EnhancedTx>('helius/transfer-native.json');
    const transfers = normalizeNativeTransfers(tx);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      from: FIX.watched,
      to: FIX.fresh,
      amountSol: 8,
      signature: tx.signature,
    });
  });

  it('applies the minSol threshold', () => {
    const tx = loadFixture<EnhancedTx>('helius/transfer-native.json');
    expect(normalizeNativeTransfers(tx, { minSol: 10 })).toHaveLength(0);
    expect(normalizeNativeTransfers(tx, { minSol: 5 })).toHaveLength(1);
  });

  it('aggregates multiple legs between the same pair (composite-unique safety)', () => {
    const tx = loadFixture<EnhancedTx>('helius/transfer-native.json');
    const doubled: EnhancedTx = {
      ...tx,
      nativeTransfers: [...(tx.nativeTransfers ?? []), ...(tx.nativeTransfers ?? [])],
    };
    const transfers = normalizeNativeTransfers(doubled);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.amountSol).toBe(16);
  });

  it('ignores swap-internal native movements only when asked to (threshold in caller)', () => {
    const tx = loadFixture<EnhancedTx>('helius/swap-pumpfun-fallback.json');
    // classify.ts only calls this for type=TRANSFER txs; the function itself stays generic
    expect(normalizeNativeTransfers(tx, { minSol: 5 })).toHaveLength(0);
  });
});
