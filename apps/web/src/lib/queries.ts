import {
  and,
  desc,
  eq,
  getDb,
  gte,
  inArray,
  isNotNull,
  liveEvents,
  lte,
  paperTrades,
  positions,
  sql,
  tokens,
  wallets,
  type LiveEventRow,
  type TokenRow,
  type WalletRow,
} from '@insiderscope/db';
import { getConfig } from '@insiderscope/shared';

const dayAgo = () => new Date(Date.now() - 24 * 3600_000);

export interface OverviewStats {
  insiders: number;
  watchlist: number;
  probation: number;
  events24h: number;
  analyzedTokens: number;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  const db = getDb();
  const tierCount = async (tier: 'insider' | 'watch' | 'probation') =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(wallets)
        .where(and(eq(wallets.tier, tier), eq(wallets.isActive, true)))
    )[0]?.n ?? 0;

  const [insiders, watchlist, probation] = await Promise.all([
    tierCount('insider'),
    tierCount('watch'),
    tierCount('probation'),
  ]);
  const events24h =
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(liveEvents)
        .where(gte(liveEvents.ts, dayAgo()))
    )[0]?.n ?? 0;
  const analyzedTokens =
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tokens)
        .where(eq(tokens.status, 'analyzed'))
    )[0]?.n ?? 0;

  return { insiders, watchlist, probation, events24h, analyzedTokens };
}

export interface FeedRow {
  id: number;
  eventType: LiveEventRow['eventType'];
  wallet: string;
  walletLabel: string | null;
  walletTier: WalletRow['tier'];
  mint: string | null;
  symbol: string | null;
  amountSol: number | null;
  mcAtEvent: number | null;
  counterparty: string | null;
  ts: string;
  signature: string;
}

export async function getFeed(opts: {
  limit?: number;
  afterId?: number;
  wallet?: string;
}): Promise<FeedRow[]> {
  const db = getDb();
  const conditions = [];
  if (opts.afterId != null) conditions.push(gte(liveEvents.id, opts.afterId + 1));
  if (opts.wallet) conditions.push(eq(liveEvents.wallet, opts.wallet));

  const rows = await db
    .select({
      id: liveEvents.id,
      eventType: liveEvents.eventType,
      wallet: liveEvents.wallet,
      walletLabel: wallets.label,
      walletTier: wallets.tier,
      mint: liveEvents.mint,
      symbol: tokens.symbol,
      amountSol: liveEvents.amountSol,
      mcAtEvent: liveEvents.mcAtEvent,
      counterparty: liveEvents.counterparty,
      ts: liveEvents.ts,
      signature: liveEvents.signature,
    })
    .from(liveEvents)
    .leftJoin(wallets, eq(liveEvents.wallet, wallets.address))
    .leftJoin(tokens, eq(liveEvents.mint, tokens.mint))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(liveEvents.id))
    .limit(opts.limit ?? 50);

  return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
}

export interface TopToken {
  mint: string;
  symbol: string | null;
  buyers: number;
  totalSol: number;
}

export async function getTopTokensToday(): Promise<TopToken[]> {
  const db = getDb();
  const rows = await db
    .select({
      mint: liveEvents.mint,
      symbol: tokens.symbol,
      buyers: sql<number>`count(distinct ${liveEvents.wallet})::int`,
      totalSol: sql<number>`coalesce(sum(${liveEvents.amountSol}), 0)`,
    })
    .from(liveEvents)
    .leftJoin(tokens, eq(liveEvents.mint, tokens.mint))
    .where(
      and(eq(liveEvents.eventType, 'buy'), gte(liveEvents.ts, dayAgo()), isNotNull(liveEvents.mint)),
    )
    .groupBy(liveEvents.mint, tokens.symbol)
    .orderBy(sql`count(distinct ${liveEvents.wallet}) desc`)
    .limit(10);
  return rows.map((r) => ({ ...r, mint: r.mint! }));
}

export interface LowCapBuyRow {
  id: number;
  ts: string;
  wallet: string;
  walletLabel: string | null;
  walletTier: WalletRow['tier'];
  mint: string;
  symbol: string | null;
  amountSol: number | null;
  entryMcUsd: number;
  peakMcUsd: number | null;
}

/**
 * The dashboard twin of the 🚀 ERKEN GİRİŞ alert: watched wallets buying while
 * the token is still small (same bar as the auto-buy). Peak prefers the
 * paper-trade peak (post-entry only), falling back to the token's observed ATH.
 */
export async function getRecentLowCapBuys(): Promise<LowCapBuyRow[]> {
  const db = getDb();
  const cfg = getConfig();
  const rows = await db
    .select({
      id: liveEvents.id,
      ts: liveEvents.ts,
      wallet: liveEvents.wallet,
      walletLabel: wallets.label,
      walletTier: wallets.tier,
      mint: liveEvents.mint,
      symbol: tokens.symbol,
      amountSol: liveEvents.amountSol,
      entryMcUsd: liveEvents.mcAtEvent,
      peakMcUsd: sql<number | null>`coalesce(${paperTrades.peakMcUsd}, ${tokens.athMcUsd})`,
    })
    .from(liveEvents)
    .innerJoin(wallets, eq(liveEvents.wallet, wallets.address))
    .leftJoin(tokens, eq(liveEvents.mint, tokens.mint))
    .leftJoin(paperTrades, eq(liveEvents.mint, paperTrades.mint))
    .where(
      and(
        eq(liveEvents.eventType, 'buy'),
        isNotNull(liveEvents.mint),
        isNotNull(liveEvents.mcAtEvent),
        lte(liveEvents.mcAtEvent, cfg.AUTOBUY_MAX_MC_USD),
        gte(liveEvents.ts, new Date(Date.now() - 48 * 3600_000)),
      ),
    )
    .orderBy(desc(liveEvents.ts), desc(liveEvents.id))
    .limit(20);
  return rows.map((r) => ({
    ...r,
    ts: r.ts.toISOString(),
    mint: r.mint!,
    entryMcUsd: r.entryMcUsd!,
  }));
}

export interface PortfolioRow {
  id: number;
  mint: string;
  symbol: string | null;
  triggerWallet: string | null;
  triggerLabel: string | null;
  isLive: boolean;
  status: 'open' | 'closed';
  solSpent: number;
  entryTs: string;
  entryMcUsd: number | null;
  lastMcUsd: number | null;
  peakMcUsd: number | null;
  troughMcUsd: number | null;
}

export interface Portfolio {
  rows: PortfolioRow[];
  stats: {
    totalCount: number;
    openCount: number;
    spentSol: number;
    /** Σ solSpent × (last/entry) — the wallet's worth at current prices. */
    currentValueSol: number;
    /** Σ solSpent × (peak/entry) — if every position had been sold at its top. */
    peakValueSol: number;
    maxX: number | null;
    /** Worst dip multiple (trough/entry) across positions. */
    minX: number | null;
  };
}

/** The auto-buy simulation portfolio: every paper/live position + totals. */
export async function getPaperPortfolio(): Promise<Portfolio> {
  const db = getDb();
  const rows = await db
    .select({
      id: paperTrades.id,
      mint: paperTrades.mint,
      symbol: tokens.symbol,
      triggerWallet: paperTrades.wallet,
      triggerLabel: wallets.label,
      isLive: paperTrades.isLive,
      status: paperTrades.status,
      solSpent: paperTrades.solSpent,
      entryTs: paperTrades.entryTs,
      entryMcUsd: paperTrades.entryMcUsd,
      lastMcUsd: paperTrades.lastMcUsd,
      peakMcUsd: paperTrades.peakMcUsd,
      troughMcUsd: paperTrades.troughMcUsd,
    })
    .from(paperTrades)
    .leftJoin(tokens, eq(paperTrades.mint, tokens.mint))
    .leftJoin(wallets, eq(paperTrades.wallet, wallets.address))
    .orderBy(desc(paperTrades.entryTs), desc(paperTrades.id))
    .limit(100);

  const xNow = sql<number>`coalesce(${paperTrades.lastMcUsd} / nullif(${paperTrades.entryMcUsd}, 0), 1)`;
  const xPeak = sql<number>`coalesce(${paperTrades.peakMcUsd} / nullif(${paperTrades.entryMcUsd}, 0), 1)`;
  const agg = (
    await db
      .select({
        totalCount: sql<number>`count(*)::int`,
        openCount: sql<number>`count(*) filter (where ${paperTrades.status} = 'open')::int`,
        spentSol: sql<number>`coalesce(sum(${paperTrades.solSpent}), 0)::float8`,
        currentValueSol: sql<number>`coalesce(sum(${paperTrades.solSpent} * ${xNow}), 0)::float8`,
        peakValueSol: sql<number>`coalesce(sum(${paperTrades.solSpent} * ${xPeak}), 0)::float8`,
        maxX: sql<number | null>`max(${paperTrades.peakMcUsd} / nullif(${paperTrades.entryMcUsd}, 0))::float8`,
        minX: sql<number | null>`min(${paperTrades.troughMcUsd} / nullif(${paperTrades.entryMcUsd}, 0))::float8`,
      })
      .from(paperTrades)
  )[0];

  return {
    rows: rows.map((r) => ({ ...r, entryTs: r.entryTs.toISOString() })),
    stats: {
      totalCount: agg?.totalCount ?? 0,
      openCount: agg?.openCount ?? 0,
      spentSol: agg?.spentSol ?? 0,
      currentValueSol: agg?.currentValueSol ?? 0,
      peakValueSol: agg?.peakValueSol ?? 0,
      maxX: agg?.maxX ?? null,
      minX: agg?.minX ?? null,
    },
  };
}

export interface BubbleWallet {
  address: string;
  label: string | null;
  tier: 'insider' | 'watch' | 'probation';
  insiderScore: number | null;
  totalPnlUsd: number | null;
}

/** Watched universe for the overview bubble map — best scores first, capped. */
export async function getBubbleWallets(): Promise<BubbleWallet[]> {
  const db = getDb();
  const rows = await db
    .select({
      address: wallets.address,
      label: wallets.label,
      tier: wallets.tier,
      insiderScore: wallets.insiderScore,
      totalPnlUsd: wallets.totalPnlUsd,
    })
    .from(wallets)
    .where(
      and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch', 'probation'])),
    )
    .orderBy(sql`${wallets.insiderScore} desc nulls last`)
    .limit(60);
  return rows.map((r) => ({ ...r, tier: r.tier as BubbleWallet['tier'] }));
}

export type SortKey = 'score' | 'winrate' | 'pnl' | 'entry' | 'trades' | 'activity';
export type TierFilter = 'all' | 'insider' | 'watch' | 'probation' | 'blacklist';

const SORT_COLUMNS = {
  score: wallets.insiderScore,
  winrate: wallets.winRate,
  pnl: wallets.totalPnlUsd,
  entry: wallets.avgEntryMc,
  trades: wallets.totalTrades,
  activity: wallets.lastActivityTs,
} as const;

export async function listWallets(opts: {
  tier: TierFilter;
  sort: SortKey;
  dir: 'asc' | 'desc';
}): Promise<WalletRow[]> {
  const db = getDb();
  const column = SORT_COLUMNS[opts.sort] ?? SORT_COLUMNS.score;
  const direction = opts.dir === 'asc' ? sql.raw('asc') : sql.raw('desc');
  const where =
    opts.tier === 'all'
      ? isNotNull(wallets.tier)
      : eq(wallets.tier, opts.tier === 'blacklist' ? 'blacklist' : opts.tier);

  return db
    .select()
    .from(wallets)
    .where(where)
    .orderBy(sql`${column} ${direction} nulls last`)
    .limit(200);
}

export async function getWallet(address: string): Promise<WalletRow | null> {
  const db = getDb();
  return (await db.select().from(wallets).where(eq(wallets.address, address)).limit(1))[0] ?? null;
}

export interface PositionWithToken {
  id: number;
  mint: string;
  symbol: string | null;
  tokenAthMcUsd: number | null;
  firstBuyTs: string | null;
  secondsAfterLaunch: number | null;
  entryMcUsd: number | null;
  entryAmountSol: number | null;
  pctOfSupply: number | null;
  exitMcUsd: number | null;
  realizedPnlUsd: number | null;
  stillHolding: boolean | null;
  creatorLinked: boolean;
}

export async function getPositions(address: string): Promise<PositionWithToken[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: positions.id,
      mint: positions.mint,
      symbol: tokens.symbol,
      tokenAthMcUsd: tokens.athMcUsd,
      firstBuyTs: positions.firstBuyTs,
      secondsAfterLaunch: positions.secondsAfterLaunch,
      entryMcUsd: positions.entryMcUsd,
      entryAmountSol: positions.entryAmountSol,
      pctOfSupply: positions.pctOfSupply,
      exitMcUsd: positions.exitMcUsd,
      realizedPnlUsd: positions.realizedPnlUsd,
      stillHolding: positions.stillHolding,
      creatorLinked: positions.creatorLinked,
    })
    .from(positions)
    .leftJoin(tokens, eq(positions.mint, tokens.mint))
    .where(eq(positions.wallet, address))
    .orderBy(sql`${positions.firstBuyTs} desc nulls last`)
    .limit(300);
  return rows.map((r) => ({ ...r, firstBuyTs: r.firstBuyTs?.toISOString() ?? null }));
}

export interface FundingTreeData {
  parents: WalletRow[];
  self: WalletRow;
  children: WalletRow[];
}

export async function getFundingTree(self: WalletRow): Promise<FundingTreeData> {
  const db = getDb();
  const parents: WalletRow[] = [];
  let cursor = self.parentWallet;
  for (let hop = 0; cursor && hop < 3; hop++) {
    const parent = (
      await db.select().from(wallets).where(eq(wallets.address, cursor)).limit(1)
    )[0];
    if (!parent) break;
    parents.unshift(parent);
    cursor = parent.parentWallet;
  }
  const children = await db
    .select()
    .from(wallets)
    .where(eq(wallets.parentWallet, self.address))
    .limit(10);
  return { parents, self, children };
}

export async function getToken(mint: string): Promise<TokenRow | null> {
  const db = getDb();
  return (await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1))[0] ?? null;
}

export interface EarlyBuyerRow {
  wallet: string;
  label: string | null;
  tier: WalletRow['tier'];
  insiderScore: number | null;
  secondsAfterLaunch: number | null;
  entryAmountSol: number | null;
  entryMcUsd: number | null;
  pctOfSupply: number | null;
  realizedPnlUsd: number | null;
  stillHolding: boolean | null;
  creatorLinked: boolean;
}

export async function getEarlyBuyers(mint: string): Promise<EarlyBuyerRow[]> {
  const db = getDb();
  return db
    .select({
      wallet: positions.wallet,
      label: wallets.label,
      tier: wallets.tier,
      insiderScore: wallets.insiderScore,
      secondsAfterLaunch: positions.secondsAfterLaunch,
      entryAmountSol: positions.entryAmountSol,
      entryMcUsd: positions.entryMcUsd,
      pctOfSupply: positions.pctOfSupply,
      realizedPnlUsd: positions.realizedPnlUsd,
      stillHolding: positions.stillHolding,
      creatorLinked: positions.creatorLinked,
    })
    .from(positions)
    .leftJoin(wallets, eq(positions.wallet, wallets.address))
    .where(and(eq(positions.mint, mint), isNotNull(positions.secondsAfterLaunch)))
    .orderBy(sql`${positions.secondsAfterLaunch} asc nulls last`)
    .limit(200);
}
