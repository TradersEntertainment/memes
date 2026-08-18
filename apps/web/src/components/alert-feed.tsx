'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { FeedRow } from '@/lib/queries';
import { shortAddr, sol, timeAgo, usd } from '@/lib/format';
import { Empty, EventBadge, td, th, tr } from './ui';

const POLL_MS = 5_000;
const MAX_ROWS = 100;

/** Live event feed: SSR initial rows, then incremental 5s polling by max id. */
export function AlertFeed({ initial, wallet }: { initial: FeedRow[]; wallet?: string }) {
  const [rows, setRows] = useState<FeedRow[]>(initial);
  const topId = useRef(initial.reduce((m, r) => Math.max(m, r.id), 0));

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const params = new URLSearchParams({ after: String(topId.current) });
        if (wallet) params.set('wallet', wallet);
        const res = await fetch(`/api/feed?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const fresh = (await res.json()) as FeedRow[];
        if (stop || fresh.length === 0) return;
        topId.current = Math.max(topId.current, ...fresh.map((r) => r.id));
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          const add = fresh.filter((r) => !seen.has(r.id));
          return [...add, ...prev].slice(0, MAX_ROWS);
        });
      } catch {
        // keep the previous render — no flash, retry next tick
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [wallet]);

  if (rows.length === 0) {
    return <Empty>No live events yet — they appear here the moment a watched wallet moves.</Empty>;
  }

  const ordered = [...rows].sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            <th className={th}>Time</th>
            <th className={th}>Event</th>
            <th className={th}>Wallet</th>
            <th className={th}>Token</th>
            <th className={`${th} text-right`}>SOL</th>
            <th className={`${th} text-right`}>MC</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.id} className={tr}>
              <td className={`${td} text-ink-3`} title={r.ts} suppressHydrationWarning>
                {timeAgo(r.ts)}
              </td>
              <td className={td}>
                <EventBadge type={r.eventType} />
              </td>
              <td className={td}>
                <Link href={`/insiders/${r.wallet}`} className="hover:text-accent">
                  {r.walletLabel ?? shortAddr(r.wallet)}
                </Link>
              </td>
              <td className={td}>
                {r.mint ? (
                  <Link href={`/tokens/${r.mint}`} className="hover:text-accent">
                    {r.symbol ? `$${r.symbol}` : shortAddr(r.mint)}
                  </Link>
                ) : r.counterparty ? (
                  <span className="text-ink-3">→ {shortAddr(r.counterparty)}</span>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </td>
              <td className={`${td} text-right`}>{sol(r.amountSol)}</td>
              <td className={`${td} text-right text-ink-2`}>{usd(r.mcAtEvent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
