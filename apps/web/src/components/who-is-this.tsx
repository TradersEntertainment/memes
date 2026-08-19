import Link from 'next/link';
import type { WalletRow } from '@insiderscope/db';
import { Empty, LinkedFlag, PnlText } from '@/components/ui';
import { pnl, shortAddr, timeAgo, usd } from '@/lib/format';
import type { PositionWithToken } from '@/lib/queries';

const BIG_TOKEN_USD = 10_000_000;
const WHALE_SUPPLY_PCT = 1;

/**
 * The identity card: answers "who is this wallet" from data the page already
 * loads — which runners it entered early (and at what cap vs. the token's
 * peak), where it holds whale-sized supply, and how it entered our radar.
 */
export function WhoIsThis({
  wallet,
  positions,
}: {
  wallet: WalletRow;
  positions: PositionWithToken[];
}) {
  const winners = positions
    .filter((p) => (p.tokenAthMcUsd ?? 0) >= BIG_TOKEN_USD)
    .sort((a, b) => (b.tokenAthMcUsd ?? 0) - (a.tokenAthMcUsd ?? 0))
    .slice(0, 4);
  const whalePositions = positions
    .filter((p) => (p.pctOfSupply ?? 0) >= WHALE_SUPPLY_PCT)
    .sort((a, b) => (b.pctOfSupply ?? 0) - (a.pctOfSupply ?? 0))
    .slice(0, 4);
  const creatorLinked = positions.filter((p) => p.creatorLinked);

  if (winners.length === 0 && whalePositions.length === 0 && creatorLinked.length === 0) {
    return (
      <Empty>
        No analyzed history yet — this wallet entered the radar from live behavior
        {wallet.parentWallet ? ` (rotation child of ${shortAddr(wallet.parentWallet)})` : ''}; its
        story fills in after the next scoring pass.
      </Empty>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      {winners.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-3">
            Made their name on
          </div>
          <ul className="space-y-1">
            {winners.map((p) => {
              const mult =
                p.entryMcUsd != null && p.entryMcUsd > 0 && p.tokenAthMcUsd != null
                  ? p.tokenAthMcUsd / p.entryMcUsd
                  : null;
              return (
                <li key={p.id} className="text-ink-2">
                  <Link href={`/tokens/${p.mint}`} className="text-ink hover:text-accent">
                    {p.symbol ? `$${p.symbol}` : shortAddr(p.mint)}
                  </Link>
                  {' — '}entered at {usd(p.entryMcUsd)}, token peaked {usd(p.tokenAthMcUsd)}
                  {mult != null && mult >= 2 && (
                    <span className="text-buy"> (×{mult >= 100 ? Math.round(mult).toLocaleString('en-US') : mult.toFixed(1)} from entry)</span>
                  )}
                  {p.realizedPnlUsd != null && (
                    <>
                      {', realized '}
                      <PnlText value={p.realizedPnlUsd} text={pnl(p.realizedPnlUsd)} />
                    </>
                  )}
                  {p.stillHolding ? ', still holding' : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {whalePositions.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-3">Whale of</div>
          <div className="text-ink-2">
            {whalePositions.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ' · '}
                <Link href={`/tokens/${p.mint}`} className="text-ink hover:text-accent">
                  {p.symbol ? `$${p.symbol}` : shortAddr(p.mint)}
                </Link>{' '}
                ({p.pctOfSupply!.toFixed(1)}% of supply)
              </span>
            ))}
          </div>
        </div>
      )}

      {creatorLinked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-ink-2">
          <LinkedFlag linked />
          <span>
            funded by / funding the creator on{' '}
            {creatorLinked.slice(0, 3).map((p, i) => (
              <span key={p.id}>
                {i > 0 && ', '}
                <Link href={`/tokens/${p.mint}`} className="text-ink hover:text-accent">
                  {p.symbol ? `$${p.symbol}` : shortAddr(p.mint)}
                </Link>
              </span>
            ))}
            {creatorLinked.length > 3 ? ` +${creatorLinked.length - 3} more` : ''} — the strongest
            insider tell we track.
          </span>
        </div>
      )}

      <div className="text-[11px] text-ink-3">
        First seen {wallet.firstSeen ? timeAgo(wallet.firstSeen) : '—'}
        {wallet.fundingSource ? ` · funded by ${wallet.fundingSource.length > 24 ? shortAddr(wallet.fundingSource) : wallet.fundingSource}` : ''}
        {wallet.parentWallet ? (
          <>
            {' · rotation child of '}
            <Link href={`/insiders/${wallet.parentWallet}`} className="hover:text-accent">
              {shortAddr(wallet.parentWallet)}
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
