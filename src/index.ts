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

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
