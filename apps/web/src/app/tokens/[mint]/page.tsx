import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreatorMap } from '@/components/creator-map';
import { Card, Empty, LinkedFlag, PnlText, StatCard, TierBadge, td, th, tr } from '@/components/ui';
import { launchDelta, pnl, shortAddr, usd, utcShort } from '@/lib/format';
import { getEarlyBuyers, getToken } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function TokenPage({ params }: { params: { mint: string } }) {
  const token = await getToken(params.mint);
  if (!token) notFound();
  const buyers = await getEarlyBuyers(token.mint);
  const insiderCount = buyers.filter((b) => b.tier === 'insider').length;
  const linkedCount = buyers.filter((b) => b.creatorLinked).length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-base text-ink">
          {token.symbol ? `$${token.symbol}` : shortAddr(token.mint)}
        </h1>
        {token.name && <span className="text-xs text-ink-2">{token.name}</span>}
        <span className="rounded border border-line px-1.5 py-px text-[10px] uppercase tracking-wider text-ink-2">
          {token.launchPlatform ?? 'unknown'}
        </span>
        <span className="rounded border border-line px-1.5 py-px text-[10px] uppercase tracking-wider text-ink-3">
          {token.status}
        </span>
        <code className="break-all text-[11px] text-ink-3">{token.mint}</code>
        <a
          href={`https://dexscreener.com/solana/${token.mint}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-ink-3 underline decoration-line hover:text-accent"
        >
          DexScreener
        </a>
        <a
          href={`https://solscan.io/token/${token.mint}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-ink-3 underline decoration-line hover:text-accent"
        >
          Solscan
        </a>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="ATH market cap" value={usd(token.athMcUsd)} />
        <StatCard label="Launched" value={token.launchTs ? utcShort(token.launchTs) : '—'} />
        <StatCard
          label="Early buyers"
          value={buyers.length}
          hint={`${insiderCount} insider(s) among them`}
        />
        <StatCard
          label="Creator-linked"
          value={linkedCount}
          hint={token.creatorWallet ? `creator ${shortAddr(token.creatorWallet)}` : undefined}
        />
      </div>

      <Card title={`Early buyers (first ${buyers.length})`}>
        {buyers.length === 0 ? (
          <Empty>Not crawled yet — run `pnpm analyzer early-buyers {shortAddr(token.mint)}`.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>#</th>
                  <th className={th}>Wallet</th>
                  <th className={th}>Tier</th>
                  <th className={`${th} text-right`}>Score</th>
                  <th className={`${th} text-right`}>After launch</th>
                  <th className={`${th} text-right`}>SOL in</th>
                  <th className={`${th} text-right`}>Entry MC</th>
                  <th className={`${th} text-right`}>Supply %</th>
                  <th className={`${th} text-right`}>PnL</th>
                  <th className={th}>Creator</th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((b, i) => (
                  <tr key={b.wallet} className={tr}>
                    <td className={`${td} text-ink-3`}>{i + 1}</td>
                    <td className={td}>
                      <Link href={`/insiders/${b.wallet}`} className="hover:text-accent">
                        {b.label ? (
                          <>
                            {b.label} <span className="text-ink-3">{shortAddr(b.wallet)}</span>
                          </>
                        ) : (
                          shortAddr(b.wallet)
                        )}
                      </Link>
                    </td>
                    <td className={td}>
                      <TierBadge tier={b.tier} />
                    </td>
                    <td className={`${td} text-right`}>
                      {b.insiderScore != null ? Math.round(b.insiderScore) : '—'}
                    </td>
                    <td className={`${td} text-right text-ink-2`}>
                      {launchDelta(b.secondsAfterLaunch)}
                    </td>
                    <td className={`${td} text-right text-ink-2`}>
                      {b.entryAmountSol != null ? b.entryAmountSol.toFixed(2) : '—'}
                    </td>
                    <td className={`${td} text-right`}>{usd(b.entryMcUsd)}</td>
                    <td className={`${td} text-right text-ink-2`}>
                      {b.pctOfSupply != null ? `${b.pctOfSupply.toFixed(2)}%` : '—'}
                    </td>
                    <td className={`${td} text-right`}>
                      <PnlText value={b.realizedPnlUsd} text={pnl(b.realizedPnlUsd)} />
                    </td>
                    <td className={td}>
                      <LinkedFlag linked={b.creatorLinked} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Creator connection map">
        {token.creatorWallet ? (
          <CreatorMap creator={token.creatorWallet} buyers={buyers} />
        ) : (
          <Empty>Creator unknown — crawl the token first.</Empty>
        )}
      </Card>
    </div>
  );
}
