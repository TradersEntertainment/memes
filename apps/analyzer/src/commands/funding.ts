import { and, eq, isNotNull, positions, sql, tokens, wallets } from '@insiderscope/db';
import {
  buildTransferGraph,
  cexLabel,
  findCreatorLink,
  HeliusCircuitOpenError,
  isCexWallet,
  primaryFunder,
  shortAddr,
  topFunders,
} from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { crawlTransfers, loadEdgesTouching } from '../lib/funding-crawl';

/**
 * Addresses already crawled in this process. `funding --all` walks 150+ wallets
 * that share a handful of creators and funders; without this every wallet would
 * re-crawl them.
 */
const crawledThisRun = new Set<string>();

export async function runFundingAll(ctx: AnalyzerCtx): Promise<void> {
  const rows = await ctx.db
    .selectDistinct({ wallet: positions.wallet })
    .from(positions)
    .innerJoin(tokens, eq(positions.mint, tokens.mint))
    .where(and(eq(tokens.status, 'analyzed'), isNotNull(tokens.creatorWallet)));
  ctx.log(`funding: ${rows.length} wallet(s) with analyzed positions`);
  let failed = 0;
  for (const { wallet } of rows) {
    // One unreachable wallet must not abandon the other 149 — but an open
    // credit circuit means every remaining wallet would fail too; abort.
    try {
      await runFunding(ctx, wallet);
    } catch (err) {
      if (err instanceof HeliusCircuitOpenError) throw err;
      failed += 1;
      ctx.log(`funding ${shortAddr(wallet)} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  ctx.log(`funding: done (${rows.length - failed}/${rows.length} wallets processed)`);
}

/**
 * Build the wallet's 2-hop funding neighborhood and mark creator-linked positions:
 * crawl the wallet's transfers, the relevant token creators', and the wallet's
 * top direct funders' (2nd hop, bounded), then BFS with CEX terminal nodes.
 */
export async function runFunding(ctx: AnalyzerCtx, wallet: string): Promise<void> {
  const { db, cfg, log } = ctx;

  const posRows = await db
    .select({
      id: positions.id,
      mint: positions.mint,
      creator: tokens.creatorWallet,
      launchTs: tokens.launchTs,
      alreadyLinked: positions.creatorLinked,
    })
    .from(positions)
    .innerJoin(tokens, eq(positions.mint, tokens.mint))
    .where(and(eq(positions.wallet, wallet), isNotNull(tokens.creatorWallet)));

  if (posRows.length === 0) {
    log(`${shortAddr(wallet)}: no positions with a known token creator — run early-buyers first`);
    return;
  }

  // Anchor the crawl window to the earliest launch this wallet was early in —
  // bundle funding happens shortly BEFORE launch, which for an older token is
  // far outside any "last N days from now" window.
  const launches = posRows
    .map((p) => p.launchTs)
    .filter((t): t is Date => t != null)
    .map((t) => t.getTime());
  const since =
    launches.length > 0
      ? new Date(Math.min(...launches) - cfg.FUNDING_LOOKBACK_DAYS * 86_400_000)
      : new Date(Date.now() - 90 * 86_400_000);

  const self = await crawlTransfers(ctx, wallet, { since, maxPages: cfg.FUNDING_MAX_PAGES });
  if (!self.reachedWindow) {
    log(
      `${shortAddr(wallet)}: transfer history truncated at the page cap before ${since.toISOString().slice(0, 10)} — creator link may be missed (raise HELIUS_MAX_PAGES_WALLET)`,
    );
  }

  const creators = [...new Set(posRows.map((p) => p.creator!).filter((c) => c !== wallet))];
  for (const creator of creators) {
    if (!crawledThisRun.has(creator)) {
      crawledThisRun.add(creator);
      await crawlTransfers(ctx, creator, { since, maxPages: cfg.FUNDING_MAX_PAGES });
    }
  }

  // 2nd hop: the wallet's biggest direct funders
  const hop1Edges = await loadEdgesTouching(ctx, [wallet]);
  const hop1Graph = buildTransferGraph(hop1Edges);
  const funders = topFunders(hop1Graph, wallet, {
    limit: cfg.FUNDING_MAX_FUNDERS,
    isCex: isCexWallet,
  });
  for (const funder of funders) {
    if (!crawledThisRun.has(funder.address)) {
      crawledThisRun.add(funder.address);
      await crawlTransfers(ctx, funder.address, { since, maxPages: 3 });
    }
  }

  const neighborhood = [wallet, ...creators, ...funders.map((f) => f.address)];
  const graph = buildTransferGraph(await loadEdgesTouching(ctx, neighborhood));

  let linked = 0;
  for (const pos of posRows) {
    const res = findCreatorLink(graph, wallet, pos.creator!, isCexWallet, 2);
    if (res.linked) {
      linked += 1;
      if (!pos.alreadyLinked) {
        await db.update(positions).set({ creatorLinked: true }).where(eq(positions.id, pos.id));
      }
      log(
        `${shortAddr(wallet)} ↔ creator ${shortAddr(pos.creator!)} (${pos.mint.slice(0, 6)}…): ${res.reason}${
          res.via?.length ? ` via ${res.via.map(shortAddr).join(' → ')}` : ''
        }`,
      );
    }
  }

  const main = primaryFunder(graph, wallet);
  await db
    .update(wallets)
    .set({
      fundingSource: main ? cexLabel(main.address) ?? main.address : null,
      updatedAt: sql`now()`,
    })
    .where(eq(wallets.address, wallet));

  log(`${shortAddr(wallet)}: ${linked}/${posRows.length} creator-linked position(s)`);
}
