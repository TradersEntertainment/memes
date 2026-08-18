import { Bot } from 'grammy';
import type { AppCtx } from '../context';
import { registerCommands } from './commands';

export function createBot(ctx: AppCtx): Bot | null {
  if (!ctx.cfg.TELEGRAM_BOT_TOKEN) {
    ctx.log('telegram disabled (TELEGRAM_BOT_TOKEN not set) — alerts will dry-run to logs');
    return null;
  }
  const bot = new Bot(ctx.cfg.TELEGRAM_BOT_TOKEN);

  // Only the configured chat may talk to the bot.
  if (ctx.cfg.TELEGRAM_CHAT_ID) {
    bot.use((c, next) =>
      String(c.chat?.id ?? '') === ctx.cfg.TELEGRAM_CHAT_ID ? next() : Promise.resolve(),
    );
  }

  registerCommands(bot, ctx);
  bot.catch((err) => ctx.log(`bot error: ${err.message}`));
  return bot;
}
