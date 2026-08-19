import { describe, expect, it } from 'vitest';
import type { EnhancedTx } from '@insiderscope/shared';
import { classifyTx } from '../src/pipeline/classify';
import type { WatchedWallet } from '../src/watched';
import { FIX, loadFixture } from './fixtures';

const payload = loadFixture<EnhancedTx[]>('helius/webhook-payload.json');
const [buyTx, transferTx, strangerTx, failedTx] = payload as [
  EnhancedTx,
  EnhancedTx,
  EnhancedTx,
  EnhancedTx,
];

function watchedWallet(address: string): WatchedWallet {
  return {
    address,
    tier: 'watch',
    label: null,
    muted: false,
    insiderScore: null,
    parentWallet: null,
    bigTokenCount: null,
  };
}

const watchedOnly = new Map([[FIX.watched, watchedWallet(FIX.watched)]]);
const CFG = { transferMinSol: 5 };

describe('classifyTx', () => {
  it('classifies a watched wallet buy', () => {
    const events = classifyTx(buyTx, watchedOnly, CFG);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'buy',
      wallet: { address: FIX.watched },
      swap: { mint: FIX.mint, solAmount: 12.5 },
    });
  });

  it('classifies an out-transfer above the threshold', () => {
    const events = classifyTx(transferTx, watchedOnly, CFG);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'transfer_out',
      transfer: { from: FIX.watched, to: FIX.fresh, amountSol: 8 },
    });
  });

  it('ignores transfers below the threshold', () => {
    expect(classifyTx(transferTx, watchedOnly, { transferMinSol: 10 })).toHaveLength(0);
  });

  it('emits transfer_in too when the receiver is watched', () => {
    const both = new Map([
      [FIX.watched, watchedWallet(FIX.watched)],
      [FIX.fresh, watchedWallet(FIX.fresh)],
    ]);
    const kinds = classifyTx(transferTx, both, CFG).map((e) => e.kind);
    expect(kinds.sort()).toEqual(['transfer_in', 'transfer_out']);
  });

  it('ignores unwatched wallets and failed txs', () => {
    expect(classifyTx(strangerTx, watchedOnly, CFG)).toHaveLength(0);
    expect(classifyTx(failedTx, watchedOnly, CFG)).toHaveLength(0);
  });

  it('never treats a SOL↔stable conversion as a trade (USDC/USDT/wSOL token leg)', () => {
    // Regression: USDC "buys" alerted as "$Cash MC $60.9B". Same tx shape as a
    // real buy, but the token side is a quote mint → zero events.
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const usdcTx = JSON.parse(
      JSON.stringify(buyTx).replaceAll(FIX.mint, usdc),
    ) as EnhancedTx;
    expect(classifyTx(usdcTx, watchedOnly, CFG)).toHaveLength(0);
  });

  it('never misreads a swap tx as a rotation (swap SOL legs stay internal)', () => {
    // the buy tx moves 12.5 SOL to the curve, but type=SWAP → no transfer events
    const events = classifyTx(buyTx, watchedOnly, { transferMinSol: 1 });
    expect(events.every((e) => e.kind === 'buy' || e.kind === 'sell')).toBe(true);
  });
});
