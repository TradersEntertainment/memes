import type { ScoreBreakdownJson } from '@insiderscope/db';

const COMPONENTS = [
  { key: 'repeat', label: 'Repeat winner', max: 25 },
  { key: 'creatorLink', label: 'Creator link', max: 25 },
  { key: 'winRate', label: 'Win rate', max: 20 },
  { key: 'selectivity', label: 'Selectivity', max: 15 },
  { key: 'timing', label: 'Entry timing', max: 15 },
] as const;

/**
 * Score component bars (single series → single accent color; the track shows
 * each component's max weight so 12/15 and 12/25 read differently).
 */
export function ScoreBreakdown({ breakdown }: { breakdown: ScoreBreakdownJson }) {
  return (
    <div className="space-y-2.5">
      {COMPONENTS.map((c) => {
        const value = breakdown.points[c.key] ?? 0;
        const width = Math.max(0, Math.min(100, (value / c.max) * 100));
        return (
          <div key={c.key}>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="text-ink-2">{c.label}</span>
              <span className="tabular-nums text-ink">
                {value.toFixed(1)}
                <span className="text-ink-3"> / {c.max}</span>
              </span>
            </div>
            <div className="h-1.5 rounded-sm bg-raised">
              <div className="h-full rounded-sm bg-accent" style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
      <div className="pt-1 text-[11px] text-ink-3">
        median entry{' '}
        {breakdown.medianEntrySeconds != null
          ? `${Math.round(breakdown.medianEntrySeconds)}s`
          : '—'}{' '}
        · {breakdown.bigTokenCount} big token(s) · {breakdown.decidedPositions} decided ·{' '}
        {breakdown.earlyPositions} early
      </div>
    </div>
  );
}
