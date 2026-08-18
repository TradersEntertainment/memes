import { shortAddr } from '@/lib/format';
import type { EarlyBuyerRow } from '@/lib/queries';

const NODE_W = 150;
const NODE_H = 26;
const GAP = 8;
const MAX_SHOWN = 14;

/**
 * Creator connection map: the token creator on the left, creator-linked early
 * buyers connected by edges on the right (unlinked buyers stay in the table).
 */
export function CreatorMap({ creator, buyers }: { creator: string; buyers: EarlyBuyerRow[] }) {
  const linked = buyers.filter((b) => b.creatorLinked).slice(0, MAX_SHOWN);
  if (linked.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-ink-3">
        No creator-linked early buyers detected (run `analyzer funding`).
      </div>
    );
  }
  const width = 520;
  const height = linked.length * (NODE_H + GAP) - GAP + 8;
  const rightX = width - NODE_W - 4;
  const creatorY = height / 2 - NODE_H / 2;
  const rowY = (i: number) => 4 + i * (NODE_H + GAP);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={Math.min(height, 420)}
        role="img"
        aria-label="Creator to early-buyer connections"
      >
        {linked.map((b, i) => (
          <line
            key={`e-${b.wallet}`}
            x1={NODE_W + 4}
            y1={creatorY + NODE_H / 2}
            x2={rightX}
            y2={rowY(i) + NODE_H / 2}
            stroke="#262a31"
            strokeWidth={1.5}
          />
        ))}
        <g transform={`translate(4, ${creatorY})`}>
          <rect width={NODE_W} height={NODE_H} rx={5} fill="#1b1e24" stroke="#fbbf24" />
          <text x={8} y={11} fontSize={9} fill="#fbbf24">
            CREATOR
          </text>
          <text x={8} y={21} fontSize={9} fill="#e6e8ee">
            {shortAddr(creator)}
          </text>
        </g>
        {linked.map((b, i) => (
          <a key={b.wallet} href={`/insiders/${b.wallet}`}>
            <g transform={`translate(${rightX}, ${rowY(i)})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={5}
                fill="#1b1e24"
                stroke={b.tier === 'insider' ? '#3987e5' : '#262a31'}
              />
              <text x={8} y={11} fontSize={9} fill="#e6e8ee">
                {b.label ? b.label.slice(0, 18) : shortAddr(b.wallet)}
              </text>
              <text x={8} y={21} fontSize={9} fill="#697080">
                {b.tier ?? 'candidate'}
                {b.insiderScore != null ? ` · ${Math.round(b.insiderScore)}` : ''}
              </text>
            </g>
          </a>
        ))}
      </svg>
    </div>
  );
}
