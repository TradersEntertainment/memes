'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Portfolio } from '@/lib/queries';
import { shortAddr, sol, timeAgo, usd } from '@/lib/format';
import { Empty, StatCard, td, th, tr } from './ui';

const POLL_MS = 10_000;

function xText(x: number | null): string {
  return x != null ? `${x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)}x` : '—';
}

/** Number is the label; color only reinforces (≥2x win, ≤0.5x loss). */
function xClass(x: number | null): string {
  if (x == null) return '';
  if (x >= 2) return 'text-buy';
  if (x <= 0.5) return 'text-sell';
  return '';
}

/**
 * The simulation portfolio: what the auto-buy bought (dry-run 🧪 or live 🤖)
 * and what each entry is worth now vs. at its peak. Whole-snapshot polling —
 * market caps keep moving after the buy.
 */
export function PaperPortfolio({ initial }: { initial: Portfolio }) {
  const [data, setData] = useState<Portfolio>(initial);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/portfolio', { cache: 'no-store' });
        if (!res.ok) return;
        const fresh = (await res.json()) as Portfolio;
        if (!stop) setData(fresh);
      } catch {
        // keep previous render, retry next tick
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  const { rows, stats } = data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          label="Positions"
          value={stats.totalCount}
          hint={`${stats.openCount} open · ${stats.totalCount - stats.openCount} closed`}
        />
        <StatCard label="Sim spent" value={`${sol(stats.spentSol)} SOL`} hint="0-risk paper buys" />
        <StatCard
          label="Peak value"
          value={`${sol(stats.peakValueSol)} SOL`}
          hint="if every top had been sold"
        />
        <StatCard label="Best X" value={xText(stats.maxX)} hint="highest peak multiple" />
        <StatCard label="Worst dip" value={xText(stats.minX)} hint="lowest trough multiple" />
      </div>

      {rows.length === 0 ? (
        <Empty>No simulated buys yet — the first insider fresh-mint signal opens one.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>Token</th>
                <th className={th}>Trigger wallet</th>
                <th className={th}>Bought</th>
                <th className={`${th} text-right`}>Entry MC</th>
                <th className={`${th} text-right`}>Peak</th>
                <th className={`${th} text-right`}>Dip</th>
                <th className={`${th} text-right`}>X max</th>
                <th className={`${th} text-right`}>X min</th>
                <th className={`${th} text-right`}>X now</th>
                <th className={`${th} text-right`}>Value</th>
                <th className={th}>Status</th>
                <th className={th}>Links</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ok = r.entryMcUsd != null && r.entryMcUsd > 0;
                const xNow = ok && r.lastMcUsd != null ? r.lastMcUsd / r.entryMcUsd! : null;
                const xPeak = ok && r.peakMcUsd != null ? r.peakMcUsd / r.entryMcUsd! : null;
                const xMin = ok && r.troughMcUsd != null ? r.troughMcUsd / r.entryMcUsd! : null;
                const valueSol = xNow != null ? r.solSpent * xNow : null;
                return (
                  <tr key={r.id} className={tr}>
                    <td className={td}>
                      <span title={r.isLive ? 'real buy' : 'dry-run (simulated)'}>
                        {r.isLive ? '🤖' : '🧪'}
                      </span>{' '}
                      <Link href={`/tokens/${r.mint}`} className="hover:text-accent">
                        {r.symbol ? `$${r.symbol}` : shortAddr(r.mint)}
                      </Link>
                    </td>
                    <td className={td}>
                      {r.triggerWallet ? (
                        <Link href={`/insiders/${r.triggerWallet}`} className="hover:text-accent">
                          {r.triggerLabel ?? shortAddr(r.triggerWallet)}
                        </Link>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={`${td} text-ink-3`} title={r.entryTs} suppressHydrationWarning>
                      {timeAgo(r.entryTs)}
                    </td>
                    <td className={`${td} text-right text-ink-2`}>{usd(r.entryMcUsd)}</td>
                    <td className={`${td} text-right text-ink-2`}>{usd(r.peakMcUsd)}</td>
                    <td className={`${td} text-right text-ink-2`}>{usd(r.troughMcUsd)}</td>
                    <td className={`${td} text-right ${xClass(xPeak)}`}>
                      <b>{xText(xPeak)}</b>
                    </td>
                    <td className={`${td} text-right ${xClass(xMin)}`}>
                      <b>{xText(xMin)}</b>
                    </td>
                    <td className={`${td} text-right text-ink-2`}>{xText(xNow)}</td>
                    <td className={`${td} text-right text-ink-2`}>
                      {valueSol != null ? `${sol(valueSol)} SOL` : '—'}
                    </td>
                    <td className={td}>
                      {r.status === 'open' ? (
                        <span className="inline-block rounded border border-accent/50 px-1.5 py-px text-[10px] uppercase tracking-wider text-accent">
                          open
                        </span>
                      ) : (
                        <span className="inline-block rounded border border-line px-1.5 py-px text-[10px] uppercase tracking-wider text-ink-3">
                          closed 14d
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-ink-2`}>
                      <a
                        href={`https://gmgn.ai/sol/token/${r.mint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-accent"
                      >
                        GMGN
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-ink-3">
        Buy-and-hold simulation: selling isn&apos;t modeled yet, so the permanent verdict of each
        entry is <b>X max</b> (peak) and <b>X min</b> (dip) — &quot;X now&quot; and
        &quot;Value&quot; are just today&apos;s snapshot. Closed rows froze after 14 days.
        🧪 = dry-run (no real money), 🤖 = real buy.
      </p>
    </div>
  );
}
