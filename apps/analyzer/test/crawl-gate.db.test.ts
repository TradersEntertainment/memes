import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sql, tokens, type DbHandle } from '@insiderscope/db';
import { getConfig, resetConfigCache } from '@insiderscope/shared';
import { crawlableCandidatesWhere, recentFirstOrder } from '../src/commands/early-buyers';

const url = process.env.DATABASE_URL;
const day = 86_400_000;

const MINT = {
  old12m: 'GATE-old-12m',
  recent6m: 'GATE-recent-6m',
  stale6m: 'GATE-stale-6m',
  seed: 'GATE-seed-null',
  grad70k: 'GATE-grad-70k',
};

describe.skipIf(!url)('crawlableCandidatesWhere — recency-priority gate', () => {
  let h: DbHandle;

  beforeAll(async () => {
    resetConfigCache();
    h = createDb(url!, { max: 2 });
    const rows = [
      { mint: MINT.old12m, athMcUsd: 12_000_000, athTs: new Date(Date.now() - 200 * day) },
      { mint: MINT.recent6m, athMcUsd: 6_000_000, athTs: new Date(Date.now() - 5 * day) },
      { mint: MINT.stale6m, athMcUsd: 6_000_000, athTs: new Date(Date.now() - 40 * day) },
      { mint: MINT.seed, athMcUsd: null, athTs: null },
      { mint: MINT.grad70k, athMcUsd: 70_000, athTs: new Date() },
    ];
    for (const r of rows) {
      await h.db.insert(tokens).values({ ...r, status: 'candidate' }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await h.db.execute(sql`delete from tokens where mint like 'GATE-%'`);
    await h.close();
  });

  it('admits $10M-ever, recent $5M peaks and seeds; excludes stale mid-caps and graduates; recent first', async () => {
    // Pin the thresholds so a developer .env can't flake the scenario.
    const cfg = {
      ...getConfig(),
      DISCOVER_MIN_MC_USD: 10_000_000,
      RECENT_MIN_MC_USD: 5_000_000,
      RECENT_WINDOW_DAYS: 14,
    };
    const rows = await h.db
      .select({ mint: tokens.mint })
      .from(tokens)
      .where(crawlableCandidatesWhere(cfg))
      .orderBy(...recentFirstOrder(cfg));
    const got = rows.map((r) => r.mint).filter((m) => m.startsWith('GATE-'));

    expect(got).toContain(MINT.old12m); // $10M ever — always in
    expect(got).toContain(MINT.recent6m); // $6M peaked 5 days ago — recency arm
    expect(got).toContain(MINT.seed); // manual/seed addition (no ATH yet)
    expect(got).not.toContain(MINT.stale6m); // $6M peaked 40 days ago — below the old bar
    expect(got).not.toContain(MINT.grad70k); // tracked graduate far below both bars
    // Priority: the recent-window runner is crawled before the old giant.
    expect(got.indexOf(MINT.recent6m)).toBeLessThan(got.indexOf(MINT.old12m));
  });
});
