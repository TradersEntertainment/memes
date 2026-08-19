import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertFeed } from '@/components/alert-feed';
import { FundingTree } from '@/components/funding-tree';
import { EntryMcHistogram, TimingHistogram } from '@/components/histograms';
import { ScoreBreakdown } from '@/components/score-breakdown';
import { Card, Empty, LinkedFlag, PnlText, StatCard, TierBadge, td, th, tr } from '@/components/ui';
import { WhoIsThis } from '@/components/who-is-this';
import { launchDelta, pct, pnl, shortAddr, timeAgo, usd } from '@/lib/format';
import { getFeed, getFundingTree, getPositions, getWallet } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function InsiderProfilePage({ params }: { params: { address: string } }) {
  const wallet = await getWallet(params.address);
  if (!wallet) notFound();

  const [positions, tree, events] = await Promise.all([
    getPositions(wallet.address),
    getFundingTree(wallet),
    getFeed({ wallet: wallet.address, limit: 30 }),
  ]);

  const entryMcs = positions
    .map((p) => p.entryMcUsd)
    .filter((v): v is number => v != null);
  const timings = positions
    .map((p) => p.secondsAfterLaunch)
    .filter((v): v is number => v != null);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-base text-ink">{wallet.label ?? shortAddr(wallet.address)}</h1>
        <TierBadge tier={wallet.tier} />
        {wallet.muted && <span className="text-[11px] text-ink-3">muted</span>}
        <code className="break-all text-[11px] text-ink-3">{wallet.address}</code>
        <a
          href={`https://solscan.io/account/${wallet.address}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-ink-3 underline decoration-line hover:text-accent"
        >
          Solscan
        </a>
        <a
          href={`https://gmgn.ai/sol/address/${wallet.address}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-ink-3 underline decoration-line hover:text-accent"
        >
          GMGN
        </a>
      </header>

      <Card title="Who is this?">
        <WhoIsThis wallet={wallet} positions={positions} />
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Insider score"
          value={wallet.insiderScore != null ? Math.round(wallet.insiderScore) : '—'}
          hint={wallet.scoreBreakdown ? `computed ${timeAgo(wallet.scoreBreakdown.computedAt)}` : undefined}
        />
        <StatCard label="Win rate" value={pct(wallet.winRate)} hint={`${wallet.totalTrades ?? '—'} trades total`} />
        <StatCard
          label="Realized PnL"
          value={<PnlText value={wallet.totalPnlUsd} text={pnl(wallet.totalPnlUsd)} />}
        />
        <StatCard
          label="Avg entry MC"
          value={usd(wallet.avgEntryMc)}
          hint={wallet.fundingSource ? `funded by ${wallet.fundingSource.length > 24 ? shortAddr(wallet.fundingSource) : wallet.fundingSource}` : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Score breakdown">
          {wallet.scoreBreakdown ? (
            <ScoreBreakdown breakdown={wallet.scoreBreakdown} />
          ) : (
            <Empty>Not scored yet — run `pnpm analyzer score {shortAddr(wallet.address)}`.</Empty>
          )}
        </Card>
        <Card title="Entry MC distribution">
          {entryMcs.length > 0 ? (
            <EntryMcHistogram values={entryMcs} />
          ) : (
            <Empty>No entries with a known MC.</Empty>
          )}
        </Card>
        <Card title="Entry timing after launch">
          {timings.length > 0 ? (
            <TimingHistogram values={timings} />
          ) : (
            <Empty>No early positions crawled.</Empty>
          )}
        </Card>
      </div>

      <Card title={`Positions (${positions.length})`}>
        {positions.length === 0 ? (
          <Empty>No positions yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>Token</th>
                  <th className={`${th} text-right`}>Entry MC</th>
                  <th className={`${th} text-right`}>Entry time</th>
                  <th className={`${th} text-right`}>SOL in</th>
                  <th className={`${th} text-right`}>Supply %</th>
                  <th className={`${th} text-right`}>Exit MC</th>
                  <th className={`${th} text-right`}>PnL</th>
                  <th className={th}>Holding</th>
                  <th className={th}>Creator</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className={tr}>
                    <td className={td}>
                      <Link href={`/tokens/${p.mint}`} className="hover:text-accent">
                        {p.symbol ? `$${p.symbol}` : shortAddr(p.mint)}
                      </Link>
                      {p.tokenAthMcUsd != null && (
                        <span className="ml-1.5 text-[10px] text-ink-3">ATH {usd(p.tokenAthMcUsd)}</span>
                      )}
                    </td>
                    <td className={`${td} text-right`}>{usd(p.entryMcUsd)}</td>
                    <td className={`${td} text-right text-ink-2`} title={p.firstBuyTs ?? undefined}>
                      {launchDelta(p.secondsAfterLaunch)}
                    </td>
                    <td className={`${td} text-right text-ink-2`}>
                      {p.entryAmountSol != null ? p.entryAmountSol.toFixed(2) : '—'}
                    </td>
                    <td className={`${td} text-right text-ink-2`}>
                      {p.pctOfSupply != null ? `${p.pctOfSupply.toFixed(2)}%` : '—'}
                    </td>
                    <td className={`${td} text-right`}>{usd(p.exitMcUsd)}</td>
                    <td className={`${td} text-right`}>
                      <PnlText value={p.realizedPnlUsd} text={pnl(p.realizedPnlUsd)} />
                    </td>
                    <td className={td}>
                      {p.stillHolding == null ? (
                        <span className="text-ink-3">—</span>
                      ) : p.stillHolding ? (
                        <span className="text-buy">yes</span>
                      ) : (
                        <span className="text-ink-3">exited</span>
                      )}
                    </td>
                    <td className={td}>
                      <LinkedFlag linked={p.creatorLinked} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Funding & rotation tree">
          {tree.parents.length === 0 && tree.children.length === 0 ? (
            <Empty>No rotation lineage — this wallet was not auto-tracked from a transfer.</Empty>
          ) : (
            <FundingTree data={tree} />
          )}
        </Card>
        <Card title="Recent activity">
          <AlertFeed initial={events} wallet={wallet.address} />
        </Card>
      </div>
    </div>
  );
}
