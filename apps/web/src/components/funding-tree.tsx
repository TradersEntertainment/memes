import type { WalletRow } from '@insiderscope/db';
import { shortAddr } from '@/lib/format';
import type { FundingTreeData } from '@/lib/queries';

const NODE_W = 150;
const NODE_H = 34;
const ROW_GAP = 30;

const tierStroke = (tier: WalletRow['tier'], self: boolean): string => {
  if (self) return '#3987e5';
  if (tier === 'probation') return '#fbbf24';
  if (tier === 'blacklist') return '#f87171';
  return '#262a31';
};

function Node({ w, x, y, self }: { w: WalletRow; x: number; y: number; self?: boolean }) {
  return (
    <a href={`/insiders/${w.address}`}>
      <g transform={`translate(${x}, ${y})`}>
        <rect
          width={NODE_W}
          height={NODE_H}
          rx={5}
          fill="#1b1e24"
          stroke={tierStroke(w.tier, self ?? false)}
          strokeWidth={1}
        />
        <text x={10} y={14} fontSize={10} fill="#e6e8ee">
          {w.label ? w.label.slice(0, 18) : shortAddr(w.address)}
        </text>
        <text x={10} y={26} fontSize={9} fill="#697080">
          {w.tier ?? 'candidate'}
          {w.insiderScore != null ? ` · ${Math.round(w.insiderScore)}` : ''}
        </text>
      </g>
    </a>
  );
}

/**
 * Rotation lineage: funding parents above, this wallet in accent, auto-tracked
 * child wallets below. Not a value chart — a small map, kept recessive.
 */
export function FundingTree({ data }: { data: FundingTreeData }) {
  const { parents, self, children } = data;
  const rows = parents.length + 1 + (children.length > 0 ? 1 : 0);
  const cols = Math.max(1, children.length);
  const width = Math.max(360, cols * (NODE_W + 16));
  const height = rows * (NODE_H + ROW_GAP) - ROW_GAP + 8;
  const centerX = width / 2 - NODE_W / 2;
  const rowY = (i: number) => 4 + i * (NODE_H + ROW_GAP);

  const childX = (i: number) =>
    children.length === 1
      ? centerX
      : (width / (children.length + 1)) * (i + 1) - NODE_W / 2;

  const selfRow = parents.length;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Wallet funding and rotation tree"
      >
        {parents.map((_, i) => (
          <line
            key={`pl-${i}`}
            x1={width / 2}
            y1={rowY(i) + NODE_H}
            x2={width / 2}
            y2={rowY(i + 1)}
            stroke="#262a31"
            strokeWidth={1.5}
          />
        ))}
        {children.map((_, i) => (
          <line
            key={`cl-${i}`}
            x1={width / 2}
            y1={rowY(selfRow) + NODE_H}
            x2={childX(i) + NODE_W / 2}
            y2={rowY(selfRow + 1)}
            stroke="#262a31"
            strokeWidth={1.5}
          />
        ))}
        {parents.map((p, i) => (
          <Node key={p.address} w={p} x={centerX} y={rowY(i)} />
        ))}
        <Node w={self} x={centerX} y={rowY(selfRow)} self />
        {children.map((c, i) => (
          <Node key={c.address} w={c} x={childX(i)} y={rowY(selfRow + 1)} />
        ))}
      </svg>
    </div>
  );
}
