import Fastify, { type FastifyInstance } from 'fastify';
import type { EnhancedTx } from '@insiderscope/shared';
import type { AppCtx } from './context';
import { processTx } from './pipeline/process';

export function buildServer(ctx: AppCtx): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

  app.get('/health', async () => ({ ok: true }));

  app.post('/webhook/helius', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!ctx.cfg.WEBHOOK_AUTH_HEADER || auth !== ctx.cfg.WEBHOOK_AUTH_HEADER) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const txs = Array.isArray(req.body) ? (req.body as EnhancedTx[]) : [];

    // Ack fast — Helius retries slow webhooks. Processing is idempotent anyway,
    // so a duplicate delivery after a crash is harmless.
    await reply.code(200).send({ received: txs.length });
    setImmediate(() => {
      void (async () => {
        for (const tx of txs) {
          try {
            await processTx(ctx.pipeline, tx, 'webhook');
          } catch (err) {
            app.log.error({ err, signature: tx?.signature }, 'webhook tx processing failed');
          }
        }
      })();
    });
  });

  return app;
}
