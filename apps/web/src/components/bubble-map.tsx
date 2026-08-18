import Link from 'next/link';
import { Empty } from '@/components/ui';
import { pnl, shortAddr } from '@/lib/format';
import type { BubbleWallet } from '@/lib/queries';

/**
 * Wallet bubble map: one circle per watched wallet, area ∝ |realized PnL|
 * (score-scaled when nobody has PnL yet), grouped color by tier. Colors are the
 * first three categorical slots validated all-pairs on this dark surface —
 * identity never rides on color alone: the legend carries words, big bubbles
 * carry labels, every bubble a native tooltip, and /insiders is the table twin.
 */
const TIER = {
  insider: { color: '#3987e5', label: 'Insider' },
  watch: { color: '#d95926', label: 'Watch' },
  probation: { color: '#199e70', label: 'Probation' },
} as const;

const R_MIN = 16;
const R_MAX = 56;
const GAP = 3; // surface gap between adjacent marks
const PAD = 8;

interface Packed {
  x: number;
  y: number;
  r: number;
  w: BubbleWallet;
}

/**
 * Deterministic circle packing (no Math.random — this renders on the server):
 * biggest first, each next circle walks an outward spiral whose start angle is
 * advanced by the golden angle per item, and lands on the first collision-free
 * spot. O(n²) with n ≤ 60.
 */
function pack(items: BubbleWallet[]): Packed[] {
  const values = items.map((w) => Math.abs(w.totalPnlUsd ?? 0));
  const vMax = Math.max(0, ...values);
  const sized = items.map((w, i) => ({
    w,
    r:
      vMax > 0
        ? R_MIN + (R_MAX - R_MIN) * Math.sqrt(values[i]! / vMax)
        : R_MIN + (R_MAX - R_MIN) * (Math.min(100, Math.max(0, w.insiderScore ?? 0)) / 100),
  }));
  sized.sort((a, b) => b.r - a.r || a.w.address.localeCompare(b.w.address));

  const placed: Packed[] = [];
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  sized.forEach(({ w, r }, i) => {
    if (placed.length === 0) {
      placed.push({ x: 0, y: 0, r, w });
      return;
    }
    const phi = i * GOLDEN;
    let x = 0;
    let y = 0;
    for (let t = 1; t < 400; t += 0.3) {
      x = 1.8 * t * Math.cos(t + phi);
      y = 1.8 * t * Math.sin(t + phi);
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + GAP)) break;
    }
    placed.push({ x, y, r, w });
  });
  return placed;
}

export function BubbleMap({ wallets }: { wallets: BubbleWallet[] }) {
  if (wallets.length === 0) {
    return (
      <Empty>
        No watched wallets yet — the pipeline promotes wallets here after each scan.
      </Empty>
    );
  }

  const packed = pack(wallets);
  const minX = Math.min(...packed.map((p) => p.x - p.r)) - PAD;
  const minY = Math.min(...packed.map((p) => p.y - p.r)) - PAD;
  const maxX = Math.max(...packed.map((p) => p.x + p.r)) + PAD;
  const maxY = Math.max(...packed.map((p) => p.y + p.r)) + PAD;

  const counts = { insider: 0, watch: 0, probation: 0 } as Record<BubbleWallet['tier'], number>;
  for (const w of wallets) counts[w.tier] += 1;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
        {(Object.keys(TIER) as (keyof typeof TIER)[]).map((tier) => (
          <span key={tier} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: TIER[tier].color }}
            />
            {TIER[tier].label} ({counts[tier]})
          </span>
        ))}
        <span className="text-ink-3">bubble area ∝ |realized PnL|</span>
      </div>
      <svg
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        role="img"
        aria-label={`Bubble map of ${wallets.length} watched wallets, sized by realized PnL`}
        className="mx-auto block h-auto w-full max-w-3xl"
      >
        {packed.map(({ x, y, r, w }) => {
          const c = TIER[w.tier];
          const name = w.label ?? shortAddr(w.address);
          // Label only when it fits inside the circle (~6px/char at 10px mono).
          const nameFits = r >= 3 * name.length + 4;
          return (
            <Link key={w.address} href={`/insiders/${w.address}`} className="group outline-none">
              <circle
                cx={x}
                cy={y}
                r={r}
                fill={c.color}
                fillOpacity={0.18}
                stroke={c.color}
                strokeWidth={1.5}
                className="transition-[fill-opacity] group-hover:[fill-opacity:0.4] group-focus-visible:[fill-opacity:0.4]"
              />
              {nameFits && (
                <text
                  x={x}
                  y={r >= 34 ? y - 3 : y + 3}
                  textAnchor="middle"
                  className="fill-ink text-[10px]"
                >
                  {name}
                </text>
              )}
              {nameFits && r >= 34 && (
                <text x={x} y={y + 11} textAnchor="middle" className="fill-ink-2 text-[9px]">
                  {w.totalPnlUsd != null ? pnl(w.totalPnlUsd) : `score ${Math.round(w.insiderScore ?? 0)}`}
                </text>
              )}
              <title>
                {`${name} — ${c.label}${
                  w.insiderScore != null ? `, score ${Math.round(w.insiderScore)}` : ''
                }, PnL ${w.totalPnlUsd != null ? pnl(w.totalPnlUsd) : '—'}`}
              </title>
            </Link>
          );
        })}
      </svg>
    </div>
  );
}
