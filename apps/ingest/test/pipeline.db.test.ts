import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  createDb,
  eq,
  inArray,
  liveEvents,
  wallets,
  type DbHandle,
} from '@insiderscope/db';
import { getConfig, resetConfigCache, type EnhancedTx } from '@insiderscope/shared';
import { processTx, type PipelineDeps, type RotationInput } from '../src/pipeline/process';
import { handleTransferOut } from '../src/pipeline/rotation';
import type { WatchedWallet } from '../src/watched';
import { FIX, loadFixture } from './fixtures';

const url = process.env.DATABASE_URL;

const PARENT2 = 'TESTIP_parent_2AAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TEST_WALLETS = [FIX.watched, FIX.fresh, PARENT2, 'TESTIP_child_a', 'TESTIP_child_b'];

function freshTs(tx: EnhancedTx, sigSuffix = ''): EnhancedTx {
  return {
    ...tx,
    timestamp: Math.floor(Date.now() / 1000),
    signature: tx.signature + sigSuffix,
  };
}

function watchedWallet(address: string, extra: Partial<WatchedWallet> = {}): WatchedWallet {
  return {
    address,
    tier: 'watch',
    label: null,
    muted: false,
    insiderScore: null,
    parentWallet: null,
    bigTokenCount: null,
    ...extra,
  };
}

describe.skipIf(!url)('processTx pipeline against real postgres', () => {
  let h: DbHandle;
  const cfg = (() => {
    resetConfigCache();
    return getConfig();
  })();
  const payload = loadFixture<EnhancedTx[]>('helius/webhook-payload.json');

  interface Harness {
    deps: PipelineDeps;
    alertIds: number[];
    rotations: RotationInput[];
  }

  function makeDeps(watched: Map<string, WatchedWallet>): Harness {
    const alertIds: number[] = [];
    const rotations: RotationInput[] = [];
    const debounced = new Set<string>();
    const deps: PipelineDeps = {
      db: h.db,
      cfg,
      log: () => {},
      getWatched: async () => watched,
      debounce: async (key) => {
        if (debounced.has(key)) return false;
        debounced.add(key);
        return true;
      },
      enqueueAlert: async (eventId) => {
        alertIds.push(eventId);
      },
      resolveMc: async () => ({ mcUsd: 45_000, source: 'test' }),
      onTransferOut: async (input) => {
        rotations.push(input);
      },
    };
    return { deps, alertIds, rotations };
  }

  async function cleanup() {
    await h.db.delete(alerts);
    await h.db.delete(liveEvents).where(inArray(liveEvents.wallet, TEST_WALLETS));
    await h.db.delete(wallets).where(inArray(wallets.parentWallet, TEST_WALLETS));
    await h.db.delete(wallets).where(inArray(wallets.address, TEST_WALLETS));
  }

  beforeAll(async () => {
    h = createDb(url!, { max: 2 });
    await cleanup();
    await h.db.insert(wallets).values({ address: FIX.watched, tier: 'watch', isActive: true });
  });

  afterAll(async () => {
    await cleanup();
    await h.close();
  });

  it('persists, enriches and alerts exactly once — replays are no-ops', async () => {
    const watched = new Map([[FIX.watched, watchedWallet(FIX.watched)]]);
    const first = makeDeps(watched);
    const txs = payload.map((tx) => freshTs(tx));

    for (const tx of txs) await processTx(first.deps, tx, 'webhook');

    const events = await h.db
      .select()
      .from(liveEvents)
      .where(eq(liveEvents.wallet, FIX.watched));
    expect(events).toHaveLength(2); // buy + transfer_out (stranger + failed tx ignored)
    const buy = events.find((e) => e.eventType === 'buy')!;
    expect(buy.mint).toBe(FIX.mint);
    expect(buy.amountSol).toBe(12.5);
    expect(buy.mcAtEvent).toBe(45_000);
    const out = events.find((e) => e.eventType === 'transfer_out')!;
    expect(out.counterparty).toBe(FIX.fresh);

    expect(first.alertIds).toEqual([buy.id]);
    expect(first.rotations).toHaveLength(1);
    expect(first.rotations[0]).toMatchObject({ target: FIX.fresh, amountSol: 8 });

    const wallet = (
      await h.db.select().from(wallets).where(eq(wallets.address, FIX.watched))
    )[0]!;
    expect(wallet.lastSig).toBeTruthy();
    expect(wallet.lastActivityTs).toBeTruthy();

    // replay the exact same txs through a fresh harness (reconcile path)
    const second = makeDeps(watched);
    for (const tx of txs) await processTx(second.deps, tx, 'reconcile');
    const eventsAfter = await h.db
      .select()
      .from(liveEvents)
      .where(eq(liveEvents.wallet, FIX.watched));
    expect(eventsAfter).toHaveLength(2);
    expect(second.alertIds).toHaveLength(0);
    expect(second.rotations).toHaveLength(0);
  });

  it('records but never alerts muted wallets and stale events', async () => {
    const muted = makeDeps(
      new Map([[FIX.watched, watchedWallet(FIX.watched, { muted: true })]]),
    );
    await processTx(muted.deps, freshTs(payload[0]!, '-muted'), 'webhook');
    expect(muted.alertIds).toHaveLength(0);

    const stale = makeDeps(new Map([[FIX.watched, watchedWallet(FIX.watched)]]));
    // original fixture timestamp is months old → beyond ALERT_MAX_AGE_MIN
    await processTx(stale.deps, { ...payload[0]!, signature: 'SigStaleReplay111' }, 'reconcile');
    expect(stale.alertIds).toHaveLength(0);

    const rows = await h.db
      .select()
      .from(liveEvents)
      .where(inArray(liveEvents.signature, [payload[0]!.signature + '-muted', 'SigStaleReplay111']));
    expect(rows).toHaveLength(2); // both recorded regardless
  });

  it('handleTransferOut tracks probation wallets with CEX + cap guards', async () => {
    const scheduled: { target: string; delayMs: number }[] = [];
    const deps = {
      db: h.db,
      cfg: { ...cfg, MAX_CHILDREN_PER_PARENT: 2 },
      log: () => {},
      scheduleRotationCheck: async (data: { target: string }, delayMs: number) => {
        scheduled.push({ target: data.target, delayMs });
      },
    };
    await h.db
      .insert(wallets)
      .values({ address: PARENT2, tier: 'insider', isActive: true })
      .onConflictDoNothing();
    const parent = watchedWallet(PARENT2, { tier: 'insider' });

    // known CEX target → ignored
    await handleTransferOut(deps, {
      parent,
      target: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
      amountSol: 50,
      signature: 'sig-cex',
    });
    // fresh target → probation + delayed check
    await handleTransferOut(deps, {
      parent,
      target: 'TESTIP_child_a',
      amountSol: 8,
      signature: 'sig-a',
    });
    // already-tracked target → no duplicate
    await handleTransferOut(deps, {
      parent,
      target: 'TESTIP_child_a',
      amountSol: 9,
      signature: 'sig-a2',
    });
    // second child fits the cap of 2
    await handleTransferOut(deps, {
      parent,
      target: 'TESTIP_child_b',
      amountSol: 8,
      signature: 'sig-b',
    });
    // third child exceeds the cap
    await handleTransferOut(deps, {
      parent,
      target: 'TESTIP_child_c',
      amountSol: 8,
      signature: 'sig-c',
    });

    const children = await h.db
      .select()
      .from(wallets)
      .where(eq(wallets.parentWallet, PARENT2));
    expect(children.map((c) => c.address).sort()).toEqual(['TESTIP_child_a', 'TESTIP_child_b']);
    expect(children.every((c) => c.tier === 'probation' && c.isActive)).toBe(true);
    expect(scheduled.map((s) => s.target)).toEqual(['TESTIP_child_a', 'TESTIP_child_b']);
    expect(scheduled[0]!.delayMs).toBe(5 * 60_000);
  });
});
