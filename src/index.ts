import type { Env } from './types';
import { runScrapeCron } from './handlers/cron';
import { getQueueStats, resetPermanentFailed } from './lib/state';

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
      const stats = await getQueueStats(env);
      return Response.json(stats);
    }

    if (url.pathname === '/run') {
      try {
        const result = await runScrapeCron(env);
        return Response.json({ ok: true, result });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 }
        );
      }
    }
if (url.pathname === '/errors') {
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') ?? '50', 10),
    200
  );
  const items = await getFailedItems(env, limit);
  return Response.json({ total: items.length, items });
}


    if (url.pathname === '/reset-failed') {
      const reset = await resetPermanentFailed(env);
      return Response.json({ ok: true, reset });
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;