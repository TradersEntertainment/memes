import { describe, expect, it, vi } from 'vitest';
import { bestPair, getPairsForTokens, pairMcUsd, type DexPair } from '../src/dexscreener';
import { FIX, loadFixture } from './fixtures';

const fixtureBody = loadFixture<{ pairs: DexPair[] }>('dexscreener/token-pairs.json');

function fetchWith(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('dexscreener client', () => {
  it('groups solana pairs by mint and drops other chains', async () => {
    const map = await getPairsForTokens([FIX.mint], fetchWith(fixtureBody));
    const pairs = map.get(FIX.mint)!;
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.chainId === 'solana')).toBe(true);
  });

  it('bestPair prefers the deepest liquidity', () => {
    const pairs = fixtureBody.pairs.filter((p) => p.chainId === 'solana');
    expect(bestPair(pairs)?.dexId).toBe('raydium');
    expect(bestPair([])).toBeNull();
  });

  it('pairMcUsd falls back from marketCap to fdv', () => {
    const [withMc, fdvOnly] = fixtureBody.pairs;
    expect(pairMcUsd(withMc!)).toBe(31_500_000);
    expect(pairMcUsd(fdvOnly!)).toBe(30_000_000);
    expect(pairMcUsd(null)).toBeNull();
  });

  it('swallows API failures and returns an empty map', async () => {
    const map = await getPairsForTokens([FIX.mint], fetchWith({ error: 'x' }, 500));
    expect(map.size).toBe(0);
  });
});
