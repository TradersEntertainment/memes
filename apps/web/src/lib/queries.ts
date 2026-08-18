import {
  and,
  desc,
  eq,
  getDb,
  gte,
  inArray,
  isNotNull,
  liveEvents,
  positions,
  sql,
  tokens,
  wallets,
  type LiveEventRow,
  type TokenRow,
  type WalletRow,
} from '@insiderscope/db';

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
