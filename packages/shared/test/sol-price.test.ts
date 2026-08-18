import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSolPriceUsdNow, resetSolPriceMemoryCache } from '../src/sol-price';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getSolPriceUsdNow — provider chain', () => {
  afterEach(() => resetSolPriceMemoryCache());

  it('uses Coinbase first', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ data: { amount: '142.35', base: 'SOL', currency: 'USD' } }),
    ) as unknown as typeof fetch;

    await expect(getSolPriceUsdNow({ fetchImpl })).resolves.toBe(142.35);
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      'coinbase',
    );
  });

  it('falls back to Binance when Coinbase is unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('coinbase')
        ? new Response('nope', { status: 403 })
        : jsonRes({ symbol: 'SOLUSDT', price: '99.5' }),
    ) as unknown as typeof fetch;

    await expect(getSolPriceUsdNow({ fetchImpl })).resolves.toBe(99.5);
  });

  it('falls back to Coinbase when Binance is geo-blocked (HTTP 451)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('binance')
        ? new Response('unavailable for legal reasons', { status: 451 })
        : jsonRes({ data: { amount: '155.10' } }),
    ) as unknown as typeof fetch;

    await expect(getSolPriceUsdNow({ fetchImpl })).resolves.toBe(155.1);
  });

  it('returns the configured fallback when every provider fails, else null', async () => {
    const dead = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(getSolPriceUsdNow({ fetchImpl: dead, fallbackUsd: 123 })).resolves.toBe(123);
    resetSolPriceMemoryCache();
    await expect(getSolPriceUsdNow({ fetchImpl: dead })).resolves.toBeNull();
  });

  it('caches the spot price for 60s', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ data: { amount: '10' } })) as unknown as typeof fetch;

    await getSolPriceUsdNow({ fetchImpl });
    await getSolPriceUsdNow({ fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
