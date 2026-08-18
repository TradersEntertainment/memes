import { escapeHtml, fmtLaunchDeltaTr, fmtUsdCompact, shortAddr } from '@insiderscope/shared';

/**
 * Turkish Telegram alert templates (HTML parse mode). Keep user-controlled
 * strings (labels, symbols) escaped — a token named "<script>" must not break
 * the message.
 */

export interface AlertWalletInfo {
  address: string;
  label: string | null;
  score: number | null;
  bigTokenCount: number | null;
}

export interface SwapAlertInput {
  kind: 'buy' | 'sell';
  wallet: AlertWalletInfo;
  mint: string;
  tokenSymbol: string | null;
  amountSol: number;
  mcUsd: number | null;
  secondsAfterLaunch: number | null;
  rotated: { parent: string } | null;
  signature: string;
}

export function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n >= 100) return String(Math.round(n));
  if (n >= 1) return trimZeros(n.toFixed(2));
  return trimZeros(n.toFixed(4));
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, '');
}

function walletLine(w: AlertWalletInfo): string {
  const name = w.label ? `${escapeHtml(w.label)} (${shortAddr(w.address)})` : shortAddr(w.address);
  const parts: string[] = [];
  if (w.score != null) parts.push(`skor ${Math.round(w.score)}`);
  if ((w.bigTokenCount ?? 0) >= 2) parts.push(`${w.bigTokenCount}x winner`);
  return parts.length > 0 ? `${name} — ${parts.join(', ')}` : name;
}

function linksLine(mint: string, signature: string): string {
  return [
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`,
    `<a href="https://solscan.io/tx/${signature}">Solscan</a>`,
    `<a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
  ].join(' | ');
}

export function formatSwapAlert(i: SwapAlertInput): string {
  const header = i.kind === 'buy' ? '🚨 <b>INSIDER BUY</b>' : '📉 <b>INSIDER SELL</b>';
  const token = i.tokenSymbol
    ? `$${escapeHtml(i.tokenSymbol)} (${shortAddr(i.mint)})`
    : shortAddr(i.mint);

  const amountParts = [`${fmtSol(i.amountSol)} SOL`, `MC: ${fmtUsdCompact(i.mcUsd)}`];
  const launchDelta = fmtLaunchDeltaTr(i.secondsAfterLaunch);
  if (launchDelta) amountParts.push(`Launch ${launchDelta}`);

  const rotated = i.rotated ? `EVET (parent: ${shortAddr(i.rotated.parent)})` : 'hayır';

  return [
    header,
    `Cüzdan: ${walletLine(i.wallet)}`,
    `Token: ${token}`,
    `Miktar: ${amountParts.join(' | ')}`,
    `Rotated wallet: ${rotated}`,
    `Linkler: ${linksLine(i.mint, i.signature)}`,
  ].join('\n');
}

export interface RotationAlertInput {
  parent: AlertWalletInfo;
  child: string;
  amountSol: number;
}

export function formatRotationAlert(i: RotationAlertInput): string {
  return [
    'ℹ️ <b>WALLET ROTATION</b>',
    `Kaynak: ${walletLine(i.parent)}`,
    `Hedef: ${shortAddr(i.child)} — izlemeye alındı (probation)`,
    `Miktar: ${fmtSol(i.amountSol)} SOL`,
    `Linkler: <a href="https://solscan.io/account/${i.child}">Solscan</a> | <a href="https://gmgn.ai/sol/address/${i.child}">GMGN</a>`,
  ].join('\n');
}
