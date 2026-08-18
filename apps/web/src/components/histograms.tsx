'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Dataviz pass: single series → one validated color (#3987e5), solid hairline
 * grid, recessive axes, rounded bar tops anchored to the baseline, no legend
 * (one series), tooltip on hover; the positions table on the same page is the
 * table-view twin of both histograms.
 */

const AXIS = { fill: '#697080', fontSize: 10 } as const;

function Histogram({ data }: { data: { bucket: string; count: number }[] }) {
  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="22%">
          <CartesianGrid stroke="#262a31" vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: '#262a31' }}
            interval={0}
          />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <Tooltip
            cursor={{ fill: 'rgba(230, 232, 238, 0.04)' }}
            contentStyle={{
              background: '#1b1e24',
              border: '1px solid #262a31',
              borderRadius: 6,
              fontSize: 11,
              fontFamily: 'inherit',
              color: '#e6e8ee',
            }}
            labelStyle={{ color: '#9aa0ad' }}
            itemStyle={{ color: '#e6e8ee' }}
            formatter={(value) => [String(value), 'positions']}
          />
          <Bar dataKey="count" fill="#3987e5" radius={[3, 3, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function bucketize(values: number[], edges: { label: string; max: number }[]): { bucket: string; count: number }[] {
  const counts = edges.map((e) => ({ bucket: e.label, count: 0 }));
  for (const v of values) {
    const idx = edges.findIndex((e) => v < e.max);
    counts[idx === -1 ? edges.length - 1 : idx]!.count += 1;
  }
  return counts;
}

/** Which MC band does this wallet enter at? */
export function EntryMcHistogram({ values }: { values: number[] }) {
  const data = bucketize(values, [
    { label: '<$10K', max: 10_000 },
    { label: '10–50K', max: 50_000 },
    { label: '50–250K', max: 250_000 },
    { label: '250K–1M', max: 1_000_000 },
    { label: '>$1M', max: Number.POSITIVE_INFINITY },
  ]);
  return <Histogram data={data} />;
}

/** How long after launch does it enter? */
export function TimingHistogram({ values }: { values: number[] }) {
  const data = bucketize(values, [
    { label: '<3s', max: 3 },
    { label: '3–15s', max: 15 },
    { label: '15–60s', max: 60 },
    { label: '1–5m', max: 300 },
    { label: '5–30m', max: 1800 },
    { label: '>30m', max: Number.POSITIVE_INFINITY },
  ]);
  return <Histogram data={data} />;
}
