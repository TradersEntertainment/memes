import { describe, expect, it, vi } from 'vitest';
import { fetchGeckoSolanaPools } from '../src/geckoterminal';
import { FIX, loadFixture } from './fixtures';

const fixtureBody = loadFixture('geckoterminal/trending-pools.json');

/** Page 1 answers with `body`, later pages are empty (natural end of listing). */
function fetchPageOne(body: unknown, status = 200): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const page = new URL(String(url)).searchParams.get('page');
    const payload = page === '1' ? body : { data: [] };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('geckoterminal client', () => {
  it('parses pools, skips flipped (wSOL-base) and non-solana entries, dedupes by mint', async () => {
    const pools = await fetchGeckoSolanaPools('trending', 2, fetchPageOne(fixtureBody));

    // 5 entries in the fixture → wSOL-base and eth entries dropped, the two WIF
    // pools collapse into one (highest market cap wins) → 2 distinct mints.
    expect(pools).toHaveLength(2);

    const wif = pools.find((p) => p.mint === FIX.mint)!;
    expect(wif.mcUsd).toBe(9_900_000); // dedupe kept the bigger pool
    expect(wif.symbol).toBe('WIF');
    expect(wif.poolCreatedAt).toBe(Date.parse('2026-08-15T09:00:00Z'));

    const goat = pools.find((p) => p.mint === FIX.buyer1)!;
    expect(goat.mcUsd).toBe(42_000_000); // market_cap_usd null → fdv fallback
    expect(goat.poolAddress).toBe('PoolFdvOnlyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('uses the top-volume endpoint for kind "top"', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/networks/solana/pools?sort=h24_volume_usd_desc');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchGeckoSolanaPools('top', 1, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns [] on HTTP errors, garbage bodies and network failures', async () => {
    await expect(
      fetchGeckoSolanaPools('trending', 1, fetchPageOne({ error: 'x' }, 500)),
    ).resolves.toEqual([]);
    await expect(
      fetchGeckoSolanaPools('trending', 1, fetchPageOne({ data: 'not-an-array' })),
    ).resolves.toEqual([]);
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchGeckoSolanaPools('trending', 1, failing)).resolves.toEqual([]);
  });
});
