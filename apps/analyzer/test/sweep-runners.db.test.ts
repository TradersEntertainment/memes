import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, inArray, tokens, type DbHandle } from '@insiderscope/db';
import { getConfig, resetConfigCache } from '@insiderscope/shared';
import { sweepRecentRunners } from '../src/commands/discover';

const url = process.env.DATABASE_URL;
const day = 86_400_000;

const MINT = {
  freshBig: 'SweepFreshRunnerAAAAAAAAAAAAAAAAAAAAAAAA',
  freshSmall: 'SweepFreshSma11AAAAAAAAAAAAAAAAAAAAAAAAA',
  staleMid: 'SweepSta1eMidAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  staleGiant: 'SweepSta1eGiantAAAAAAAAAAAAAAAAAAAAAAAAA',
};

function poolEntry(mint: string, mcUsd: number, createdAgoMs: number) {
  return {
    id: `solana_pool_${mint}`,
    type: 'pool',
    attributes: {
      name: 'TEST / SOL',
      address: `Poo1${mint.slice(4)}`,
      pool_created_at: new Date(Date.now() - createdAgoMs).toISOString(),
      fdv_usd: String(mcUsd),
      market_cap_usd: String(mcUsd),
    },
    relationships: { base_token: { data: { id: `solana_${mint}` } } },
  };
}

describe.skipIf(!url)('sweepRecentRunners — pair-age-aware discovery floor', () => {
  let h: DbHandle;

  beforeAll(() => {
    resetConfigCache();
    h = createDb(url!, { max: 2 });
  });

  afterAll(async () => {
    await h.db.delete(tokens).where(inArray(tokens.mint, Object.values(MINT)));
    await h.close();
  });

  it('admits fresh $5M+ and old $10M+ runners, rejects the rest', async () => {
    const body = {
      data: [
        poolEntry(MINT.freshBig, 6_000_000, 5 * day), // fresh, above recent bar → in
        poolEntry(MINT.freshSmall, 3_000_000, 5 * day), // fresh but tiny → out
        poolEntry(MINT.staleMid, 6_000_000, 400 * day), // old pool, below $10M → out
        poolEntry(MINT.staleGiant, 12_000_000, 400 * day), // old but $10M+ → in
      ],
    };
    const fetchImpl = vi.fn(async (u: string | URL) => {
      const s = new URL(String(u));
      const payload =
        s.pathname.includes('trending_pools') && s.searchParams.get('page') === '1'
          ? body
          : { data: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = {
      ...getConfig(),
      DISCOVER_MIN_MC_USD: 10_000_000,
      RECENT_MIN_MC_USD: 5_000_000,
      RECENT_WINDOW_DAYS: 14,
    };
    const added = await sweepRecentRunners({ db: h.db, cfg, log: () => {} }, fetchImpl);
    expect(added).toBe(2);

    const rows = await h.db
      .select({ mint: tokens.mint, status: tokens.status, athMcUsd: tokens.athMcUsd })
      .from(tokens)
      .where(inArray(tokens.mint, Object.values(MINT)));
    const got = new Map(rows.map((r) => [r.mint, r]));
    expect(got.get(MINT.freshBig)?.status).toBe('candidate');
    expect(got.get(MINT.freshBig)?.athMcUsd).toBe(6_000_000);
    expect(got.get(MINT.staleGiant)?.status).toBe('candidate');
    expect(got.has(MINT.freshSmall)).toBe(false);
    expect(got.has(MINT.staleMid)).toBe(false);
  });
});
