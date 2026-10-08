import type { Env } from './types';
import { runScrapeCron } from './handlers/cron';
import { getStats } from './lib/state';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'yukio-api',
        role: 'anime-scraper',
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/stats') {
      const stats = await getStats(env);
      return Response.json(stats);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runScrapeCron(env);
          console.log(
            `[Cron] done — success=${result.succeeded}, failed=${result.failed}, skipped=${result.skipped}`
          );
        } catch (err) {
          console.error('[Cron] failed:', err);
        }
      })()
    );
  },
} satisfies ExportedHandler<Env>;