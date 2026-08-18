import { describe, expect, it } from 'vitest';
import type { EnhancedTx, LaunchInfo } from '@insiderscope/shared';
import { extractEarlyBuyers, secondsAfterLaunch } from '../src/lib/early-buyers';

const MINT = 'MemeCoinMintAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
const CURVE = 'BondingCurvePdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const T0 = 1755500000;
const SLOT0 = 1000;

const LAUNCH: LaunchInfo = {
  platform: 'pumpfun',
  launchTs: new Date(T0 * 1000),
  launchSlot: SLOT0,
  creator: 'CreatorDevAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

let sigSeq = 0;
function swapTx(
  wallet: string,
  direction: 'buy' | 'sell',
  sol: number,
  tokenAmount: number,
  slotOffset: number,
): EnhancedTx {
  sigSeq += 1;
  const slot = SLOT0 + slotOffset;
  const ts = T0 + Math.round((slotOffset * 400) / 1000);
  const solLeg = { amount: Math.round(sol * 1e9) };
  return {
    signature: `sig-${sigSeq}`,
    timestamp: ts,
    slot,
    type: 'SWAP',
    source: 'PUMP_FUN',
    feePayer: wallet,
    transactionError: null,
    nativeTransfers: [
      direction === 'buy'
        ? { fromUserAccount: wallet, toUserAccount: CURVE, ...solLeg }
        : { fromUserAccount: CURVE, toUserAccount: wallet, ...solLeg },
    ],
    tokenTransfers: [
      direction === 'buy'
        ? { fromUserAccount: CURVE, toUserAccount: wallet, mint: MINT, tokenAmount }
        : { fromUserAccount: wallet, toUserAccount: CURVE, mint: MINT, tokenAmount },
    ],
    events: {},
    instructions: [],
  };
}

const CFG = { mint: MINT, windowSec: 1800, maxBuyers: 150 };

describe('secondsAfterLaunch', () => {
  it('prefers slot deltas (400ms) for sub-second resolution', () => {
    expect(secondsAfterLaunch({ slot: SLOT0 + 5, ts: new Date((T0 + 60) * 1000) }, LAUNCH)).toBe(2);
  });

  it('falls back to timestamps when slots are missing', () => {
    expect(secondsAfterLaunch({ slot: 0, ts: new Date((T0 + 90) * 1000) }, LAUNCH)).toBe(90);
  });
});

describe('extractEarlyBuyers', () => {
  it('collects buyers with slot-derived entry timing', () => {
    const { buys } = extractEarlyBuyers(
      [swapTx('alpha', 'buy', 2, 1_000_000, 10), swapTx('beta', 'buy', 5, 2_000_000, 600)],
      LAUNCH,
      CFG,
    );
    expect(buys).toHaveLength(2);
    expect(buys[0]).toMatchObject({ wallet: 'alpha', solAmount: 2, secondsAfterLaunch: 4 });
    expect(buys[1]).toMatchObject({ wallet: 'beta', secondsAfterLaunch: 240 });
  });

  it('only the first buy per wallet counts', () => {
    const { buys } = extractEarlyBuyers(
      [swapTx('alpha', 'buy', 2, 1_000_000, 10), swapTx('alpha', 'buy', 9, 4_000_000, 50)],
      LAUNCH,
      CFG,
    );
    expect(buys).toHaveLength(1);
    expect(buys[0]!.solAmount).toBe(2);
  });

  it('closes the window by time', () => {
    // windowSec 1800 → slot offset 4500 = 1800s is inside; 4501 = 1800.4s is out
    const { buys } = extractEarlyBuyers(
      [swapTx('early', 'buy', 1, 100, 4500), swapTx('late', 'buy', 1, 100, 4501)],
      LAUNCH,
      CFG,
    );
    expect(buys.map((b) => b.wallet)).toEqual(['early']);
  });

  it('closes the window by max buyer count', () => {
    const { buys } = extractEarlyBuyers(
      [
        swapTx('a', 'buy', 1, 100, 10),
        swapTx('b', 'buy', 1, 100, 20),
        swapTx('c', 'buy', 1, 100, 30),
      ],
      LAUNCH,
      { ...CFG, maxBuyers: 2 },
    );
    expect(buys.map((b) => b.wallet)).toEqual(['a', 'b']);
  });

  it('keeps collecting early-buyer sells after the window closes, ignores strangers', () => {
    const { buys, sells } = extractEarlyBuyers(
      [
        swapTx('alpha', 'buy', 2, 1_000_000, 10),
        swapTx('stranger', 'sell', 3, 500_000, 5000),
        swapTx('alpha', 'sell', 4, 900_000, 6000), // way past the entry window
      ],
      LAUNCH,
      CFG,
    );
    expect(buys).toHaveLength(1);
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ wallet: 'alpha', direction: 'sell', solAmount: 4 });
  });

  it('skips failed transactions', () => {
    const failed = { ...swapTx('alpha', 'buy', 2, 1_000_000, 10), transactionError: { e: 1 } };
    const { buys } = extractEarlyBuyers([failed], LAUNCH, CFG);
    expect(buys).toHaveLength(0);
  });
});
