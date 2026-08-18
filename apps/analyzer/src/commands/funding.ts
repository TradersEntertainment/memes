import { and, eq, isNotNull, positions, sql, tokens, wallets } from '@insiderscope/db';
import {
  buildTransferGraph,
  cexLabel,
  findCreatorLink,
  isCexWallet,
  primaryFunder,
  shortAddr,
  topFunders,
} from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { crawlTransfers, hasTransfersFor, loadEdgesTouching } from '../lib/funding-crawl';

export async function runFundingAll(ctx: AnalyzerCtx): Promise<void> {
  const rows = await ctx.db
    .selectDistinct({ wallet: positions.wallet })
    .from(positions)
    .innerJoin(tokens, eq(positions.mint, tokens.mint))
    .where(and(eq(tokens.status, 'analyzed'), isNotNull(tokens.creatorWallet)));
  ctx.log(`funding: ${rows.length} wallet(s) with analyzed positions`);
  for (const { wallet } of rows) {
    await runFunding(ctx, wallet);
  }
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
      alreadyLinked: positions.creatorLinked,
    })
    .from(positions)
    .innerJoin(tokens, eq(positions.mint, tokens.mint))
    .where(and(eq(positions.wallet, wallet), isNotNull(tokens.creatorWallet)));

  if (posRows.length === 0) {
    log(`${shortAddr(wallet)}: no positions with a known token creator — run early-buyers first`);
    return;
  }

  await crawlTransfers(ctx, wallet);

  const creators = [...new Set(posRows.map((p) => p.creator!).filter((c) => c !== wallet))];
  for (const creator of creators) {
    if (!(await hasTransfersFor(ctx, creator))) {
      await crawlTransfers(ctx, creator, { maxPages: 5 });
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
    if (!(await hasTransfersFor(ctx, funder.address))) {
      await crawlTransfers(ctx, funder.address, { maxPages: 3 });
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
