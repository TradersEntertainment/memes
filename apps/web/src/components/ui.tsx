import type { ReactNode } from 'react';
import type { WalletRow } from '@insiderscope/db';

export function Card({ title, children, className = '' }: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-line bg-surface ${className}`}>
      {title != null && (
        <header className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-widest text-ink-3">
          {title}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function StatCard({ label, value, hint }: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-widest text-ink-3">{label}</div>
      <div className="mt-1 text-2xl text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

const TIER_STYLES: Record<string, string> = {
  insider: 'border-accent/50 text-accent',
  watch: 'border-ink-3/50 text-ink-2',
  probation: 'border-warn/50 text-warn',
  blacklist: 'border-sell/50 text-sell',
};

export function TierBadge({ tier }: { tier: WalletRow['tier'] }) {
  if (!tier) return <span className="text-ink-3">—</span>;
  return (
    <span
      className={`inline-block rounded border px-1.5 py-px text-[10px] uppercase tracking-wider ${
        TIER_STYLES[tier] ?? 'border-line text-ink-2'
      }`}
    >
      {tier}
    </span>
  );
}

/** Event badges always carry the word — color never means alone. */
const EVENT_STYLES: Record<string, { label: string; cls: string }> = {
  buy: { label: 'BUY', cls: 'border-buy/50 text-buy' },
  sell: { label: 'SELL', cls: 'border-sell/50 text-sell' },
  transfer_out: { label: 'ROT OUT', cls: 'border-warn/50 text-warn' },
  transfer_in: { label: 'ROT IN', cls: 'border-warn/50 text-warn' },
};

export function EventBadge({ type }: { type: string }) {
  const s = EVENT_STYLES[type] ?? { label: type.toUpperCase(), cls: 'border-line text-ink-2' };
  return (
    <span
      className={`inline-block w-[64px] rounded border px-1 py-px text-center text-[10px] tracking-wider ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

export function LinkedFlag({ linked }: { linked: boolean }) {
  if (!linked) return <span className="text-ink-3">—</span>;
  return (
    <span className="inline-block rounded border border-accent/50 px-1.5 py-px text-[10px] uppercase tracking-wider text-accent">
      creator-linked
    </span>
  );
}

export function PnlText({ value, text }: { value: number | null | undefined; text: string }) {
  if (value == null) return <span className="text-ink-3">—</span>;
  return <span className={value >= 0 ? 'text-buy' : 'text-sell'}>{text}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-xs text-ink-3">{children}</div>;
}

export const th = 'px-2 py-1.5 text-left text-[10px] font-normal uppercase tracking-widest text-ink-3';
export const td = 'px-2 py-1.5 whitespace-nowrap tabular-nums';
export const tr = 'border-b border-line/60 last:border-0 hover:bg-raised/60';
