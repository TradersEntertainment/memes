import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, eq, inArray, paperTrades, tokens, type DbHandle } from '@insiderscope/db';
import { getConfig, resetConfigCache, type AppConfig } from '@insiderscope/shared';
import { maybeAutoBuy, type AutoBuyDeps, type AutoBuySignal } from '../src/autobuy/executor';
import { closeStalePaperTrades, paperStats, updatePaperMc } from '../src/autobuy/tracker';

const url = process.env.DATABASE_URL;

const MINT = {
  fresh: 'AutoBuyFreshMintAAAAAAAAAAAAAAAAAAAAAAAA',
  second: 'AutoBuySecondMintAAAAAAAAAAAAAAAAAAAAAAA',
  third: 'AutoBuyThirdMintAAAAAAAAAAAAAAAAAAAAAAAA',
  old: 'AutoBuyO1dMintAAAAAAAAAAAAAAAAAAAAAAAAAA',
  stale: 'AutoBuySta1eMintAAAAAAAAAAAAAAAAAAAAAAAA',
};
const INSIDER = 'AutoBuyInsiderWa11etAAAAAAAAAAAAAAAAAAAA';

function cfgWith(over: Partial<AppConfig>): AppConfig {
  resetConfigCache();
  return {
    ...getConfig(),
    AUTOBUY_ENABLED: true,
    AUTOBUY_DRY_RUN: true,
    AUTOBUY_SOL_PER_TRADE: 0.25,
    AUTOBUY_DAILY_CAP_SOL: 1.25,
    AUTOBUY_MAX_MINT_AGE_MIN: 60,
    AUTOBUY_MAX_MC_USD: 1_000_000,
    AUTOBUY_TIERS: 'insider,watch',
    AUTOBUY_MAX_TOP_HOLDER_PCT: 0, // bait guard exercised in its own test
    ALERT_MAX_AGE_MIN: 15,
    ...over,
  };
}

describe.skipIf(!url)('auto-buy executor + tracker (real postgres)', () => {
  let h: DbHandle;
  const notifications: string[] = [];

  function deps(cfg: AppConfig): AutoBuyDeps {
    return {
      db: h.db,
      cfg,
      log: () => {},
      pumpCache: null,
      helius: null,
      isPaused: async () => false,
      notify: async (text) => {
        notifications.push(text);
      },
    };
  }

  function signal(over: Partial<AutoBuySignal> = {}): AutoBuySignal {
    return {
      wallet: { address: INSIDER, tier: 'insider', label: null, insiderScore: 82 },
      mint: MINT.fresh,
      mcUsd: 45_000,
      ts: new Date(),
      ...over,
    };
  }

  beforeAll(() => {
    h = createDb(url!, { max: 2 });
  });

  beforeEach(async () => {
    notifications.length = 0;
    await h.db.delete(paperTrades).where(inArray(paperTrades.mint, Object.values(MINT)));
    await h.db.delete(tokens).where(inArray(tokens.mint, Object.values(MINT)));
  });

  afterAll(async () => {
    await h.db.delete(paperTrades).where(inArray(paperTrades.mint, Object.values(MINT)));
    await h.db.delete(tokens).where(inArray(tokens.mint, Object.values(MINT)));
    await h.close();
  });

  it('opens a dry-run position for a fresh insider buy and notifies', async () => {
    const out = await maybeAutoBuy(deps(cfgWith({})), signal());
    expect(out).toBe('dry');
    const rows = await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.fresh));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isLive).toBe(false);
    expect(rows[0]!.solSpent).toBe(0.25);
    expect(rows[0]!.entryMcUsd).toBe(45_000);
    expect(notifications[0]).toContain('DRY-RUN ALIM');
  });

  it('never buys the same mint twice', async () => {
    await maybeAutoBuy(deps(cfgWith({})), signal());
    const again = await maybeAutoBuy(deps(cfgWith({})), signal());
    expect(again).toBe('skipped');
    const rows = await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.fresh));
    expect(rows).toHaveLength(1);
  });

  it('rejects non-fresh mints, wrong tiers, stale events and paused state', async () => {
    // big + no launch info = not fresh
    expect(await maybeAutoBuy(deps(cfgWith({})), signal({ mcUsd: 5_000_000 }))).toBe('skipped');
    // probation tier not in the allowlist
    expect(
      await maybeAutoBuy(
        deps(cfgWith({})),
        signal({ wallet: { address: INSIDER, tier: 'probation', label: null, insiderScore: 40 } }),
      ),
    ).toBe('skipped');
    // reconciliation backfill (old event) must never buy
    expect(
      await maybeAutoBuy(deps(cfgWith({})), signal({ ts: new Date(Date.now() - 30 * 60_000) })),
    ).toBe('skipped');
    // kill switch
    const paused = { ...deps(cfgWith({})), isPaused: async () => true };
    expect(await maybeAutoBuy(paused, signal())).toBe('skipped');
    expect(await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.fresh))).toHaveLength(0);
  });

  it('enforces the daily SOL ceiling across positions', async () => {
    const cfg = cfgWith({ AUTOBUY_SOL_PER_TRADE: 0.5, AUTOBUY_DAILY_CAP_SOL: 1 });
    expect(await maybeAutoBuy(deps(cfg), signal({ mint: MINT.fresh }))).toBe('dry');
    expect(await maybeAutoBuy(deps(cfg), signal({ mint: MINT.second }))).toBe('dry');
    expect(await maybeAutoBuy(deps(cfg), signal({ mint: MINT.third }))).toBe('skipped'); // 1.5 > 1
  });

  it('tracks the peak, fires each milestone once, and closes stale positions', async () => {
    await maybeAutoBuy(deps(cfgWith({})), signal({ mcUsd: 50_000 }));

    expect(await updatePaperMc(h.db, MINT.fresh, 80_000)).toBeNull(); // 1.6x — below 2x
    const twoX = await updatePaperMc(h.db, MINT.fresh, 110_000); // 2.2x
    expect(twoX).toContain('2X OLDU');
    expect(await updatePaperMc(h.db, MINT.fresh, 115_000)).toBeNull(); // still 2x band
    const fiveX = await updatePaperMc(h.db, MINT.fresh, 260_000); // 5.2x
    expect(fiveX).toContain('5X OLDU');
    // peak never moves down, trough never moves up
    await updatePaperMc(h.db, MINT.fresh, 30_000);
    const row = (await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.fresh)))[0]!;
    expect(row.peakMcUsd).toBe(260_000);
    expect(row.lastMcUsd).toBe(30_000);
    expect(row.troughMcUsd).toBe(30_000); // dropped below the 50K entry seed
    await updatePaperMc(h.db, MINT.fresh, 90_000); // recovery must not lift the trough
    const after = (await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.fresh)))[0]!;
    expect(after.troughMcUsd).toBe(30_000);

    const stats = await paperStats(h.db);
    expect(stats.openCount).toBeGreaterThanOrEqual(1);
    expect(stats.maxX).toBeGreaterThanOrEqual(5);
    expect(stats.minX).toBeLessThanOrEqual(0.6); // 30K/50K
    expect(stats.minX).toBeGreaterThan(0);

    // 15-day-old position gets closed
    await h.db.insert(paperTrades).values({
      mint: MINT.stale,
      solSpent: 0.25,
      entryMcUsd: 10_000,
      entryTs: new Date(Date.now() - 15 * 86_400_000),
    });
    expect(await closeStalePaperTrades(h.db, 14)).toBeGreaterThanOrEqual(1);
    const staleRow = (await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.stale)))[0]!;
    expect(staleRow.status).toBe('closed');
    expect(await updatePaperMc(h.db, MINT.stale, 99_000)).toBeNull(); // closed = frozen
  });

  it('signs and sends through the live path when dry-run is off', async () => {
    const { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } = await import(
      '@solana/web3.js'
    );
    const bs58 = (await import('bs58')).default;
    const burner = Keypair.generate();
    // A realistic unsigned tx like trade-local returns.
    const msg = new TransactionMessage({
      payerKey: burner.publicKey,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)),
      instructions: [
        SystemProgram.transfer({ fromPubkey: burner.publicKey, toPubkey: burner.publicKey, lamports: 1 }),
      ],
    }).compileToV0Message();
    const unsigned = new VersionedTransaction(msg);

    const fetchImpl = vi.fn(async () =>
      new Response(Buffer.from(unsigned.serialize()), { status: 200 }),
    ) as unknown as typeof fetch;
    const rpc = vi.fn(async () => 'FakeTxSignature111');
    const cfg = cfgWith({
      AUTOBUY_DRY_RUN: false,
      AUTOBUY_WALLET_SECRET: bs58.encode(burner.secretKey),
    });
    const d: AutoBuyDeps = {
      ...deps(cfg),
      fetchImpl,
      helius: { rpc } as unknown as AutoBuyDeps['helius'],
    };

    const out = await maybeAutoBuy(d, signal({ mint: MINT.second }));
    expect(out).toBe('live');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const sendCall = rpc.mock.calls.find((c) => (c as unknown[])[0] === 'sendTransaction') as
      | [string, unknown[]]
      | undefined;
    expect(sendCall).toBeTruthy();
    const params = sendCall![1];
    // the sent payload deserializes back into a tx SIGNED by the burner
    const sent = VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64'));
    expect(sent.signatures[0]!.some((b) => b !== 0)).toBe(true);
    const row = (await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.second)))[0]!;
    expect(row.isLive).toBe(true);
    expect(row.txSignature).toBe('FakeTxSignature111');
    expect(notifications[0]).toContain('GERÇEK ALIM');
  });

  it('skips the buy when one wallet holds too much supply (bait guard)', async () => {
    const cfg = cfgWith({ AUTOBUY_MAX_TOP_HOLDER_PCT: 40 });
    const rpc = vi.fn(async (method: string) =>
      method === 'getTokenLargestAccounts'
        ? { value: [{ address: 'BaiterAcc', uiAmount: 600_000_000 }] } // 60% of 1B
        : null,
    );
    const d: AutoBuyDeps = { ...deps(cfg), helius: { rpc } as unknown as AutoBuyDeps['helius'] };
    const out = await maybeAutoBuy(d, signal({ mint: MINT.old }));
    expect(out).toBe('skipped');
    expect(await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.old))).toHaveLength(0);
  });

  it('drops the position and warns when the live buy fails', async () => {
    const bs58 = (await import('bs58')).default;
    const { Keypair } = await import('@solana/web3.js');
    const cfg = cfgWith({
      AUTOBUY_DRY_RUN: false,
      AUTOBUY_WALLET_SECRET: bs58.encode(Keypair.generate().secretKey),
    });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const d: AutoBuyDeps = {
      ...deps(cfg),
      fetchImpl,
      helius: { rpc: vi.fn() } as unknown as AutoBuyDeps['helius'],
    };
    const out = await maybeAutoBuy(d, signal({ mint: MINT.third }));
    expect(out).toBe('skipped');
    expect(await h.db.select().from(paperTrades).where(eq(paperTrades.mint, MINT.third))).toHaveLength(0);
    expect(notifications.at(-1)).toContain('BAŞARISIZ');
  });
});
