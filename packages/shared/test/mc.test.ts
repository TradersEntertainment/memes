import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, gte, lte, and, solPrices, type DbHandle } from '@insiderscope/db';
import { swapDerivedMcSol } from '../src/mc';
import { getSolPriceUsdAt, resetSolPriceMemoryCache } from '../src/sol-price';

describe('swapDerivedMcSol', () => {
  it('derives MC from the swap itself', () => {
    // 2.5 SOL for 12.5M tokens of a 1B-supply token → price 2e-7 SOL → MC 200 SOL
    expect(swapDerivedMcSol(2.5, 12_500_000, 1_000_000_000)).toBeCloseTo(200, 9);
  });

  it('rejects degenerate inputs', () => {
    expect(swapDerivedMcSol(0, 1, 1)).toBeNull();
    expect(swapDerivedMcSol(1, 0, 1)).toBeNull();
    expect(swapDerivedMcSol(1, 1, 0)).toBeNull();
  });
});

const url = process.env.DATABASE_URL;
// hour used only by this test — far from anything else
const TEST_HOUR = new Date('2020-06-15T13:00:00Z');

describe.skipIf(!url)('getSolPriceUsdAt (real postgres, stubbed binance)', () => {
  let h: DbHandle;

  async function cleanup() {
    await h.db
      .delete(solPrices)
      .where(
        and(
          gte(solPrices.ts, new Date('2020-06-14T00:00:00Z')),
          lte(solPrices.ts, new Date('2020-06-17T00:00:00Z')),
        ),
      );
  }

  beforeAll(async () => {
    h = createDb(url!, { max: 2 });
    await cleanup();
    resetSolPriceMemoryCache();
  });

  afterAll(async () => {
    await cleanup();
    await h.close();
  });

  it('backfills from the price provider on a cache miss, then serves from the db', async () => {
    // Coinbase candle shape: [ time(seconds), low, high, open, close, volume ]
    const candles = [-2, -1, 0, 1, 2].map((offset) => [
      (TEST_HOUR.getTime() + offset * 3600_000) / 1000,
      149,
      151,
      150,
      offset === 0 ? 150.5 : 150.0,
      1000,
    ]);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(candles), { status: 200 }),
    ) as unknown as typeof fetch;

    const price = await getSolPriceUsdAt(h.db, new Date('2020-06-15T13:45:12Z'), { fetchImpl });
    expect(price).toBe(150.5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // second lookup hits the db — a broken fetch must not matter
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const cached = await getSolPriceUsdAt(h.db, new Date('2020-06-15T13:59:59Z'), {
      fetchImpl: failing,
    });
    expect(cached).toBe(150.5);
    expect(failing).not.toHaveBeenCalled();
  });

  it('falls back to the nearest cached hour when binance is unreachable', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    // 20:00 has no candle; nearest cached is 15:00 (150.0) from the previous test
    const price = await getSolPriceUsdAt(h.db, new Date('2020-06-15T20:10:00Z'), {
      fetchImpl: failing,
    });
    expect(price).toBe(150.0);
  });

  it('uses the configured fallback when nothing is cached nearby', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const price = await getSolPriceUsdAt(h.db, new Date('2019-01-01T00:00:00Z'), {
      fetchImpl: failing,
      fallbackUsd: 123,
    });
    expect(price).toBe(123);
    const none = await getSolPriceUsdAt(h.db, new Date('2019-01-01T00:00:00Z'), {
      fetchImpl: failing,
    });
    expect(none).toBeNull();
  });
});
