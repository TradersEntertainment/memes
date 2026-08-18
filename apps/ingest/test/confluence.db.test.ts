import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, inArray, liveEvents, tokens, wallets, type DbHandle } from '@insiderscope/db';
import { getConfig, resetConfigCache } from '@insiderscope/shared';
import { buildConfluenceAlert } from '../src/pipeline/confluence';

const url = process.env.DATABASE_URL;

const MINT = 'TESTCF_MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
const W = ['TESTCF_insider_1', 'TESTCF_watch_2', 'TESTCF_blacklist_3'];

describe.skipIf(!url)('buildConfluenceAlert (real postgres)', () => {
  let h: DbHandle;
  const cfg = (() => {
    resetConfigCache();
    return getConfig();
  })();

  async function cleanup() {
    await h.db.delete(liveEvents).where(inArray(liveEvents.wallet, W));
    await h.db.delete(wallets).where(inArray(wallets.address, W));
    await h.db.delete(tokens).where(inArray(tokens.mint, [MINT]));
  }

  beforeAll(async () => {
    h = createDb(url!, { max: 2 });
    await cleanup();
    await h.db.insert(tokens).values({ mint: MINT, symbol: 'CONF' });
    await h.db.insert(wallets).values([
      { address: W[0]!, tier: 'insider', label: 'alpha', insiderScore: 84, isActive: true },
      { address: W[1]!, tier: 'watch', insiderScore: 55, isActive: true },
      { address: W[2]!, tier: 'blacklist', isActive: false },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await h.close();
  });

  async function insertBuy(wallet: string, sig: string, minutesAgo: number) {
    await h.db.insert(liveEvents).values({
      wallet,
      eventType: 'buy',
      mint: MINT,
      amountSol: 1,
      ts: new Date(Date.now() - minutesAgo * 60_000),
      signature: sig,
    });
  }

  it('stays quiet below the threshold and ignores blacklisted/expired buyers', async () => {
    await insertBuy(W[0]!, 'cf-sig-1', 5);
    await insertBuy(W[2]!, 'cf-sig-black', 5); // blacklisted — must not count
    await insertBuy(W[1]!, 'cf-sig-old', cfg.CONFLUENCE_WINDOW_MIN + 30); // outside window
    expect(await buildConfluenceAlert(h.db, cfg, MINT)).toBeNull();
  });

  it('fires once a second watched wallet buys inside the window', async () => {
    await insertBuy(W[1]!, 'cf-sig-2', 2);
    const hit = await buildConfluenceAlert(h.db, cfg, MINT);
    expect(hit).not.toBeNull();
    expect(hit!.buyers).toBe(2);
    expect(hit!.text).toContain('CONFLUENCE');
    expect(hit!.text).toContain('$CONF');
    expect(hit!.text).toContain('alpha');
    expect(hit!.text).toContain('⭐');
    expect(hit!.text).toContain('👀');
  });
});
