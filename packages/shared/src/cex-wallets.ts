/**
 * Known CEX hot wallets on Solana. These are terminal nodes in the funding graph:
 * we never traverse through them, they never count as a "common funder", and
 * rotation tracking ignores transfers whose target is (or quickly forwards to) one.
 *
 * The list is a best-effort static snapshot of widely known hot wallets — extend it
 * as new ones are identified; addresses are treated as opaque strings elsewhere.
 */
export const CEX_WALLETS: Record<string, string> = {
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance 2',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Coinbase',
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: 'Coinbase 2',
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: 'Coinbase Hot',
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': 'OKX',
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: 'Bybit',
  FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: 'Kraken',
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: 'Gate.io',
  BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: 'KuCoin',
  AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS: 'MEXC',
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: 'MEXC 2',
};

const cexSet = new Set(Object.keys(CEX_WALLETS));

export function isCexWallet(address: string): boolean {
  return cexSet.has(address);
}

export function cexLabel(address: string): string | null {
  return CEX_WALLETS[address] ?? null;
}
