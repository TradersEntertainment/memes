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

export interface PastWin {
  symbol: string | null;
  mint: string;
  entryMcUsd: number | null;
  athMcUsd: number | null;
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
  /** Fresh-mint emphasis thresholds — pass from config so 🚀 matches auto-buy. */
  freshMaxAgeSec?: number;
  freshMaxMcUsd?: number;
  /** Dashboard base URL — when set the wallet name links to its profile page. */
  profileBaseUrl?: string;
  /** The wallet's best past $10M+ positions — the "who is this" one-liner. */
  pastWins?: PastWin[];
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

function walletLine(w: AlertWalletInfo, profileBaseUrl?: string): string {
  let name = w.label ? `${escapeHtml(w.label)} (${shortAddr(w.address)})` : shortAddr(w.address);
  if (profileBaseUrl) {
    name = `<a href="${profileBaseUrl}/insiders/${w.address}">${name}</a>`;
  }
  const parts: string[] = [];
  if (w.score != null) parts.push(`skor ${Math.round(w.score)}`);
  if ((w.bigTokenCount ?? 0) >= 2) parts.push(`${w.bigTokenCount}x winner`);
  return parts.length > 0 ? `${name} — ${parts.join(', ')}` : name;
}

/** "Geçmişi: $WIF giriş $61K → tepe $3.2B · $POPCAT …" — who this wallet is. */
function pastWinsLine(wins: PastWin[]): string | null {
  if (wins.length === 0) return null;
  const parts = wins.map((w) => {
    const name = w.symbol ? `$${escapeHtml(w.symbol)}` : shortAddr(w.mint);
    if (w.entryMcUsd != null && w.athMcUsd != null) {
      return `${name} giriş ${fmtUsdCompact(w.entryMcUsd)} → tepe ${fmtUsdCompact(w.athMcUsd)}`;
    }
    return w.athMcUsd != null ? `${name} (tepe ${fmtUsdCompact(w.athMcUsd)})` : name;
  });
  return `Geçmişi: ${parts.join(' · ')}`;
}

function linksLine(mint: string, signature: string, withBuyLinks = false): string {
  const links = [
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`,
    `<a href="https://solscan.io/tx/${signature}">Solscan</a>`,
    `<a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
  ];
  if (withBuyLinks) {
    links.push(`<a href="https://jup.ag/swap/SOL-${mint}">Jupiter'de AL</a>`);
    links.push(`<a href="https://pump.fun/${mint}">pump.fun</a>`);
  }
  return links.join(' | ');
}

/** "Fresh mint": young launch or still tiny — the run-and-buy moment. */
export function isFreshMintBuy(
  i: Pick<SwapAlertInput, 'kind' | 'secondsAfterLaunch' | 'mcUsd' | 'freshMaxAgeSec' | 'freshMaxMcUsd'>,
): boolean {
  if (i.kind !== 'buy') return false;
  const maxAge = i.freshMaxAgeSec ?? 3600;
  const maxMc = i.freshMaxMcUsd ?? 1_000_000;
  return (
    (i.secondsAfterLaunch != null && i.secondsAfterLaunch >= 0 && i.secondsAfterLaunch <= maxAge) ||
    (i.mcUsd != null && i.mcUsd <= maxMc)
  );
}

export function formatSwapAlert(i: SwapAlertInput): string {
  const fresh = isFreshMintBuy(i);
  const header =
    i.kind === 'sell'
      ? '📉 <b>INSIDER SELL</b>'
      : fresh
        ? '🚀 <b>ERKEN GİRİŞ — INSIDER YENİ TOKEN ALDI</b>'
        : '🚨 <b>INSIDER BUY</b>';
  const token = i.tokenSymbol
    ? `$${escapeHtml(i.tokenSymbol)} (${shortAddr(i.mint)})`
    : shortAddr(i.mint);

  const amountParts = [`${fmtSol(i.amountSol)} SOL`, `MC: ${fmtUsdCompact(i.mcUsd)}`];
  const launchDelta = fmtLaunchDeltaTr(i.secondsAfterLaunch);
  if (launchDelta) amountParts.push(`Launch ${launchDelta}`);

  const rotated = i.rotated ? `EVET (parent: ${shortAddr(i.rotated.parent)})` : 'hayır';
  const wins = pastWinsLine(i.pastWins ?? []);

  return [
    header,
    `Cüzdan: ${walletLine(i.wallet, i.profileBaseUrl)}`,
    ...(wins ? [wins] : []),
    `Token: ${token}`,
    `Miktar: ${amountParts.join(' | ')}`,
    `Rotated wallet: ${rotated}`,
    `Linkler: ${linksLine(i.mint, i.signature, fresh)}`,
  ].join('\n');
}

export interface RotationAlertInput {
  parent: AlertWalletInfo;
  child: string;
  amountSol: number;
  profileBaseUrl?: string;
}

export function formatRotationAlert(i: RotationAlertInput): string {
  return [
    'ℹ️ <b>WALLET ROTATION</b>',
    `Kaynak: ${walletLine(i.parent, i.profileBaseUrl)}`,
    `Hedef: ${shortAddr(i.child)} — izlemeye alındı (probation)`,
    `Miktar: ${fmtSol(i.amountSol)} SOL`,
    `Linkler: <a href="https://solscan.io/account/${i.child}">Solscan</a> | <a href="https://gmgn.ai/sol/address/${i.child}">GMGN</a>`,
  ].join('\n');
}
