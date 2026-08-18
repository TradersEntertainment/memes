import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  eq,
  inArray,
  liveEvents,
  positions,
  transfers,
  wallets,
  type DbHandle,
} from '../src';

const url = process.env.DATABASE_URL;

const W1 = 'TESTDB_wallet_1';
const W2 = 'TESTDB_wallet_2';
const MINT = 'TESTDB_mint_1';
const SIG = 'TESTDB_sig_1';
const TS = new Date('2026-01-01T00:00:00Z');

describe.skipIf(!url)('schema constraints against real postgres', () => {
  let h: DbHandle;

  async function cleanup() {
    await h.db.delete(liveEvents).where(inArray(liveEvents.wallet, [W1, W2]));
    await h.db.delete(positions).where(inArray(positions.wallet, [W1, W2]));
    await h.db.delete(transfers).where(eq(transfers.signature, SIG));
    await h.db.delete(wallets).where(inArray(wallets.address, [W1, W2]));
  }

  beforeAll(async () => {
    h = createDb(url!, { max: 2 });
    await cleanup();
    await h.db
      .insert(wallets)
      .values([{ address: W1 }, { address: W2 }])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await cleanup();
    await h.close();
  });

  it('positions upsert on (wallet, mint) updates instead of duplicating', async () => {
    await h.db.insert(positions).values({ wallet: W1, mint: MINT, entryAmountSol: 1 });
    await h.db
      .insert(positions)
      .values({ wallet: W1, mint: MINT, entryAmountSol: 2 })
      .onConflictDoUpdate({
        target: [positions.wallet, positions.mint],
        set: { entryAmountSol: 2 },
      });

    const rows = await h.db.select().from(positions).where(eq(positions.wallet, W1));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entryAmountSol).toBe(2);
  });

  it('live_events allows the same signature for two wallets but blocks replays', async () => {
    const first = await h.db
      .insert(liveEvents)
      .values({ wallet: W1, eventType: 'transfer_out', signature: SIG, ts: TS, amountSol: 7 })
      .onConflictDoNothing()
      .returning({ id: liveEvents.id });
    const second = await h.db
      .insert(liveEvents)
      .values({ wallet: W2, eventType: 'transfer_in', signature: SIG, ts: TS, amountSol: 7 })
      .onConflictDoNothing()
      .returning({ id: liveEvents.id });
    const replay = await h.db
      .insert(liveEvents)
      .values({ wallet: W1, eventType: 'transfer_out', signature: SIG, ts: TS, amountSol: 7 })
      .onConflictDoNothing()
      .returning({ id: liveEvents.id });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(replay).toHaveLength(0);

    const rows = await h.db.select().from(liveEvents).where(eq(liveEvents.signature, SIG));
    expect(rows).toHaveLength(2);
  });

  it('transfers dedupe on (signature, from, to) while allowing other pairs in the same tx', async () => {
    await h.db
      .insert(transfers)
      .values({ signature: SIG, fromWallet: W1, toWallet: W2, amountSol: 5, ts: TS })
      .onConflictDoNothing();
    await h.db
      .insert(transfers)
      .values({ signature: SIG, fromWallet: W1, toWallet: W2, amountSol: 5, ts: TS })
      .onConflictDoNothing();
    await h.db
      .insert(transfers)
      .values({ signature: SIG, fromWallet: W2, toWallet: W1, amountSol: 1, ts: TS })
      .onConflictDoNothing();

    const rows = await h.db.select().from(transfers).where(eq(transfers.signature, SIG));
    expect(rows).toHaveLength(2);
  });
});
