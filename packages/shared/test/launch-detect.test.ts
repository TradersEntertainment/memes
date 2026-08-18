import { describe, expect, it } from 'vitest';
import { detectLaunch } from '../src/launch-detect';
import type { EnhancedTx } from '../src/helius/types';
import { FIX, loadFixture } from './fixtures';

const create = loadFixture<EnhancedTx>('helius/pumpfun-create.json');
const buy = loadFixture<EnhancedTx>('helius/swap-buy-events.json');
const poolInit = loadFixture<EnhancedTx>('helius/raydium-pool-init.json');
const transfer = loadFixture<EnhancedTx>('helius/transfer-native.json');

describe('detectLaunch', () => {
  it('detects a pump.fun CREATE tx', () => {
    const launch = detectLaunch([create, buy]);
    expect(launch).toEqual({
      platform: 'pumpfun',
      launchTs: new Date(1755500000 * 1000),
      launchSlot: 362000000,
      creator: FIX.creator,
    });
  });

  it('finds the pump.fun create even when it is not the first tx in the list', () => {
    const launch = detectLaunch([buy, create]);
    expect(launch?.platform).toBe('pumpfun');
    expect(launch?.launchSlot).toBe(362000000);
  });

  it('detects a Raydium pool init', () => {
    const launch = detectLaunch([poolInit, buy]);
    expect(launch?.platform).toBe('raydium');
    expect(launch?.creator).toBe(poolInit.feePayer);
    expect(launch?.launchSlot).toBe(361750000);
  });

  it('falls back to the oldest successful tx as the launch', () => {
    const launch = detectLaunch([transfer]);
    expect(launch?.platform).toBe('other');
    expect(launch?.creator).toBe(FIX.watched);
  });

  it('skips failed txs and returns null for an empty history', () => {
    expect(detectLaunch([])).toBeNull();
    expect(detectLaunch([{ ...transfer, transactionError: { err: 1 } }])).toBeNull();
  });
});
