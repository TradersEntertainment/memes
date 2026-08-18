import { closeDb } from '@insiderscope/db';
import { buildCtx } from './context';
import { runDiscover } from './commands/discover';
import { runEarlyBuyers, runEarlyBuyersAll } from './commands/early-buyers';
import { runFunding, runFundingAll } from './commands/funding';
import { runImportDir, runImportTokens } from './commands/import-tokens';
import { runScoreAll, runScoreWallet } from './commands/score';

const USAGE = `InsiderScope analyzer

Usage:
  pnpm analyzer import-tokens <file.csv>     seed candidate tokens (mint[,symbol[,ath_mc_usd[,name]]])
  pnpm analyzer import-dir [dir]             import every *.csv in TOKENS_DIR (default /data/tokens)
  pnpm analyzer discover                     refresh ATHs + scan DexScreener feeds for new candidates
  pnpm analyzer early-buyers <mint> | --all  crawl launch history, extract early buyers into positions
  pnpm analyzer funding <wallet> | --all     build funding graph, mark creator-linked positions
  pnpm analyzer score [wallet]               score wallets (default: every wallet with analyzed positions)

Typical pipeline: import-tokens → early-buyers --all → funding --all → score
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const first = args[0];

  switch (cmd) {
    case 'discover':
      await runDiscover(buildCtx());
      return;
    case 'import-tokens': {
      if (!first) throw new Error(`missing csv path\n\n${USAGE}`);
      await runImportTokens(buildCtx(), first);
      return;
    }
    case 'import-dir': {
      await runImportDir(buildCtx(), first);
      return;
    }
    case 'early-buyers': {
      const ctx = buildCtx();
      if (args.includes('--all')) await runEarlyBuyersAll(ctx);
      else if (first) await runEarlyBuyers(ctx, first);
      else throw new Error(`missing <mint> (or --all)\n\n${USAGE}`);
      return;
    }
    case 'funding': {
      const ctx = buildCtx();
      if (args.includes('--all')) await runFundingAll(ctx);
      else if (first) await runFunding(ctx, first);
      else throw new Error(`missing <wallet> (or --all)\n\n${USAGE}`);
      return;
    }
    case 'score': {
      const ctx = buildCtx();
      if (first && !first.startsWith('--')) await runScoreWallet(ctx, first);
      else await runScoreAll(ctx);
      return;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
