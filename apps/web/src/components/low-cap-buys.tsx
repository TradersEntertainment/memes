'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { LowCapBuyRow } from '@/lib/queries';
import { shortAddr, sol, timeAgo, usd } from '@/lib/format';
import { Empty, TierBadge, td, th, tr } from './ui';

const POLL_MS = 10_000;

/**
 * The run-and-buy board: watched wallets entering tokens that are still small.
 * Whole-list refresh (not an append feed) because rows mutate — the peak and
 * the X multiple keep growing after the buy.
 */
export function LowCapBuys({ initial }: { initial: LowCapBuyRow[] }) {
  const [rows, setRows] = useState<LowCapBuyRow[]>(initial);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/lowcap', { cache: 'no-store' });
        if (!res.ok) return;
        const fresh = (await res.json()) as LowCapBuyRow[];
        if (!stop) setRows(fresh);
      } catch {
        // keep the previous render, retry next tick
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  if (rows.length === 0) {
    return (
      <Empty>
        No low-cap insider buys in the last 48h — the moment a watched wallet apes a fresh mint
        it lands here.
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            <th className={th}>Time</th>
            <th className={th}>Wallet</th>
            <th className={th}>Tier</th>
            <th className={th}>Token</th>
            <th className={`${th} text-right`}>SOL</th>
            <th className={`${th} text-right`}>Entry MC</th>
            <th className={`${th} text-right`}>Peak</th>
            <th className={`${th} text-right`}>X</th>
            <th className={th}>Buy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const x = r.peakMcUsd != null && r.entryMcUsd > 0 ? r.peakMcUsd / r.entryMcUsd : null;
            return (
              <tr key={r.id} className={tr}>
                <td className={`${td} text-ink-3`} title={r.ts} suppressHydrationWarning>
                  {timeAgo(r.ts)}
                </td>
                <td className={td}>
                  <Link href={`/insiders/${r.wallet}`} className="hover:text-accent">
                    {r.walletLabel ?? shortAddr(r.wallet)}
                  </Link>
                </td>
                <td className={td}>
                  <TierBadge tier={r.walletTier} />
                </td>
                <td className={td}>
                  <Link href={`/tokens/${r.mint}`} className="hover:text-accent">
                    {r.symbol ? `$${r.symbol}` : shortAddr(r.mint)}
                  </Link>
                </td>
                <td className={`${td} text-right`}>{sol(r.amountSol)}</td>
                <td className={`${td} text-right text-ink-2`}>{usd(r.entryMcUsd)}</td>
                <td className={`${td} text-right text-ink-2`}>{usd(r.peakMcUsd)}</td>
                <td className={`${td} text-right ${x != null && x >= 2 ? 'text-buy' : ''}`}>
                  {x != null ? `${x.toFixed(1)}x` : '—'}
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
                  {' · '}
                  <a
                    href={`https://jup.ag/swap/SOL-${r.mint}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-accent"
                  >
                    Jup
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
