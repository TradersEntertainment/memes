import { LAMPORTS_PER_SOL } from './constants';

export function lamportsToSol(lamports: number | string): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function shortAddr(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Loose base58 pubkey check — good enough to validate user input. */
export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function hourFloor(ts: Date): Date {
  const d = new Date(ts.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** $45K / $1.2M style compact USD formatting (alerts + dashboard). */
export function fmtUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '?';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000)}K`;
  return `${sign}$${abs < 10 ? abs.toFixed(2) : Math.round(abs)}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

/** "Launch +4dk" / "+38sn" style delta used by Turkish alerts. */
export function fmtLaunchDeltaTr(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `+${Math.round(seconds)}sn`;
  if (seconds < 3600) return `+${Math.round(seconds / 60)}dk`;
  if (seconds < 86400) return `+${(seconds / 3600).toFixed(1).replace(/\.0$/, '')}sa`;
  return `+${Math.round(seconds / 86400)}g`;
}
