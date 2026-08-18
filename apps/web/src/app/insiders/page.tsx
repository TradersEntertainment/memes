import Link from 'next/link';
import { Card, Empty, PnlText, TierBadge, td, th, tr } from '@/components/ui';
import { pct, pnl, shortAddr, timeAgo, usd } from '@/lib/format';
import { listWallets, type SortKey, type TierFilter } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const TIERS: TierFilter[] = ['all', 'insider', 'watch', 'probation', 'blacklist'];
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'score', label: 'Score' },
  { key: 'winrate', label: 'Win rate' },
  { key: 'pnl', label: 'PnL' },
  { key: 'entry', label: 'Avg entry MC' },
  { key: 'trades', label: 'Trades' },
  { key: 'activity', label: 'Last activity' },
];

interface Search {
  tier?: string;
  sort?: string;
  dir?: string;
}

export default async function InsidersPage({ searchParams }: { searchParams: Search }) {
  const tier = (TIERS.includes(searchParams.tier as TierFilter)
    ? searchParams.tier
    : 'all') as TierFilter;
  const sort = (SORTS.some((s) => s.key === searchParams.sort)
    ? searchParams.sort
    : 'score') as SortKey;
  const dir = searchParams.dir === 'asc' ? 'asc' : 'desc';
  const rows = await listWallets({ tier, sort, dir });

  const href = (over: Partial<{ tier: string; sort: string; dir: string }>) => {
    const params = new URLSearchParams({ tier, sort, dir, ...over });
    return `/insiders?${params.toString()}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {TIERS.map((t) => (
          <Link
            key={t}
            href={href({ tier: t })}
            className={`rounded border px-2 py-1 uppercase tracking-wider ${
              t === tier
                ? 'border-accent/60 bg-accent/10 text-accent'
                : 'border-line text-ink-3 hover:text-ink-2'
            }`}
          >
            {t}
          </Link>
        ))}
        <span className="ml-auto text-ink-3">{rows.length} wallet(s)</span>
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty>
            Nothing here yet — run the analyzer pipeline (import-tokens → early-buyers → funding →
            score) or /add wallets via Telegram.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>Wallet</th>
                  <th className={th}>Tier</th>
                  {SORTS.map((s) => (
                    <th key={s.key} className={`${th} text-right`}>
                      <Link
                        href={href({ sort: s.key, dir: sort === s.key && dir === 'desc' ? 'asc' : 'desc' })}
                        className={sort === s.key ? 'text-ink' : 'hover:text-ink-2'}
                      >
                        {s.label}
                        {sort === s.key ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.address} className={tr}>
                    <td className={td}>
                      <Link href={`/insiders/${w.address}`} className="hover:text-accent">
                        {w.label ? (
                          <>
                            {w.label} <span className="text-ink-3">{shortAddr(w.address)}</span>
                          </>
                        ) : (
                          shortAddr(w.address)
                        )}
                      </Link>
                      {w.muted ? <span className="ml-1 text-ink-3">muted</span> : null}
                    </td>
                    <td className={td}>
                      <TierBadge tier={w.tier} />
                    </td>
                    <td className={`${td} text-right`}>
                      {w.insiderScore != null ? Math.round(w.insiderScore) : '—'}
                    </td>
                    <td className={`${td} text-right`}>{pct(w.winRate)}</td>
                    <td className={`${td} text-right`}>
                      <PnlText value={w.totalPnlUsd} text={pnl(w.totalPnlUsd)} />
                    </td>
                    <td className={`${td} text-right text-ink-2`}>{usd(w.avgEntryMc)}</td>
                    <td className={`${td} text-right text-ink-2`}>{w.totalTrades ?? '—'}</td>
                    <td className={`${td} text-right text-ink-3`}>{timeAgo(w.lastActivityTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
