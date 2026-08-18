import { describe, expect, it, vi } from 'vitest';
import { HeliusClient } from '../src/helius/client';
import type { EnhancedTx } from '../src/helius/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeTx(signature: string): EnhancedTx {
  return {
    signature,
    timestamp: 1755500000,
    slot: 1,
    type: 'SWAP',
    source: 'RAYDIUM',
    feePayer: 'x',
  };
}

describe('HeliusClient', () => {
  it('requires an api key', () => {
    expect(() => new HeliusClient({ apiKey: '' })).toThrow(/HELIUS_API_KEY/);
  });

  it('retries on 429 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse([fakeTx('sig1')]));
    const client = new HeliusClient({ apiKey: 'k', fetchImpl, baseDelayMs: 1, maxRetries: 2 });

    const txs = await client.getParsedTransactions('addr');
    expect(txs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails after maxRetries and strips the api key from errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new HeliusClient({ apiKey: 'supersecret', fetchImpl, baseDelayMs: 1, maxRetries: 1 });

    await expect(client.getParsedTransactions('addr')).rejects.toThrow(/api-key=\*\*\*/);
    await expect(client.getParsedTransactions('addr')).rejects.not.toThrow(/supersecret/);
  });

  it('does not retry 4xx client errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const client = new HeliusClient({ apiKey: 'k', fetchImpl, baseDelayMs: 1 });

    await expect(client.getParsedTransactions('addr')).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paginates history via the before cursor and stops on an empty page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fakeTx(`a${i}`));
    const page2 = [fakeTx('b0'), fakeTx('b1')];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      const before = u.searchParams.get('before');
      if (!before) return jsonResponse(page1);
      if (before === 'a99') return jsonResponse(page2);
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const client = new HeliusClient({ apiKey: 'k', fetchImpl });

    const all = await client.fetchHistoryOldestFirst('addr');
    expect(all).toHaveLength(102);
    // oldest first: last fetched tx comes first after reversal
    expect(all[0]!.signature).toBe('b1');
    expect(all.at(-1)!.signature).toBe('a0');
  });

  it('enforces the page cap inside the iterator', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(Array.from({ length: 100 }, (_, i) => fakeTx(`s${Math.random()}-${i}`))),
    ) as unknown as typeof fetch;
    const client = new HeliusClient({ apiKey: 'k', fetchImpl });

    const all = await client.fetchHistoryOldestFirst('addr', { maxPages: 3 });
    expect(all).toHaveLength(300);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('unwraps rpc results and surfaces rpc errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ result: { value: { uiAmount: 1_000_000_000, decimals: 6 } } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }));
    const client = new HeliusClient({ apiKey: 'k', fetchImpl });

    await expect(client.getTokenSupply('mint')).resolves.toEqual({
      uiAmount: 1_000_000_000,
      decimals: 6,
    });
    await expect(client.rpc('getTokenSupply', ['mint'])).rejects.toThrow(/nope/);
  });
});
