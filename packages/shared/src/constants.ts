export const LAMPORTS_PER_SOL = 1_000_000_000;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPFUN_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/** pump.fun tokens always mint exactly 1B supply with 6 decimals. */
export const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;
export const PUMPFUN_TOKEN_DECIMALS = 6;

export const HELIUS_API_BASE = 'https://api.helius.xyz';
export const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';
export const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';
export const GECKOTERMINAL_API_BASE = 'https://api.geckoterminal.com';
export const BINANCE_API_BASE = 'https://api.binance.com';
export const COINBASE_API_BASE = 'https://api.coinbase.com';
export const COINBASE_EXCHANGE_API_BASE = 'https://api.exchange.coinbase.com';
export const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

/**
 * Quote-side mints that are never "the token": a swap whose token leg is one of
 * these is a SOL↔stable conversion, not a memecoin trade — excluded from live
 * classification, scoring aggregates, and discovery alike.
 */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
/** Self-custody trade builder: returns a serialized tx to sign locally. */
export const PUMPPORTAL_TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';

/** Average Solana slot time — used to derive sub-second entry timing from slot deltas. */
export const SLOT_MS = 400;
