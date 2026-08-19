import Link from 'next/link';
import { AlertFeed } from '@/components/alert-feed';
import { BubbleMap } from '@/components/bubble-map';
import { LowCapBuys } from '@/components/low-cap-buys';
import { Card, Empty, StatCard, td, th, tr } from '@/components/ui';
import { shortAddr, sol } from '@/lib/format';
import {
  getBubbleWallets,
  getFeed,
  getOverviewStats,
  getRecentLowCapBuys,
  getTopTokensToday,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [stats, feed, topTokens, bubbleWallets, lowCapBuys] = await Promise.all([
    getOverviewStats(),
    getFeed({ limit: 50 }),
    getTopTokensToday(),
    getBubbleWallets(),
    getRecentLowCapBuys(),
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Insiders" value={stats.insiders} hint="active, score ≥ 70" />
        <StatCard label="Watchlist" value={stats.watchlist} hint="score 50–70 + manual" />
        <StatCard label="Probation" value={stats.probation} hint="rotation targets" />
        <StatCard label="Events 24h" value={stats.events24h} hint="buys, sells, rotations" />
        <StatCard label="Tokens analyzed" value={stats.analyzedTokens} hint="early-buyer crawls" />
      </div>

      <Card title="🚀 Recent low-cap insider buys — last 48h">
        <LowCapBuys initial={lowCapBuys} />
      </Card>

      <Card
        title={
          <span className="flex items-center justify-between">
            Wallet map — watched universe
            <Link href="/insiders" className="normal-case tracking-normal text-accent hover:underline">
              Full table →
            </Link>
          </span>
        }
      >
        <BubbleMap wallets={bubbleWallets} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Live feed — last 24h" className="lg:col-span-2">
          <AlertFeed initial={feed} />
        </Card>

        <Card title="Most bought today">
          {topTokens.length === 0 ? (
            <Empty>No insider buys in the last 24h.</Empty>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>Token</th>
                  <th className={`${th} text-right`}>Buyers</th>
                  <th className={`${th} text-right`}>SOL in</th>
                </tr>
              </thead>
              <tbody>
                {topTokens.map((t) => (
                  <tr key={t.mint} className={tr}>
                    <td className={td}>
                      <Link href={`/tokens/${t.mint}`} className="hover:text-accent">
                        {t.symbol ? `$${t.symbol}` : shortAddr(t.mint)}
                      </Link>
                    </td>
                    <td className={`${td} text-right`}>{t.buyers}</td>
                    <td className={`${td} text-right text-ink-2`}>{sol(t.totalSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
