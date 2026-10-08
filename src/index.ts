import type { Env } from './types';
import { runScrapeCron, runScrapeManual } from './handlers/cron';
import { getStats, getScrapeState, resetStaleInProgress } from './lib/state';

const API_VERSION = 'v2';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-API-Version': API_VERSION,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return json({
        status: 'ok',
        service: 'yukio-api',
        version: API_VERSION,
        role: 'anime-scraper',
        timestamp: new Date().toISOString(),
      });
    }

    if (path === '/stats') {
      const stats = await getStats(env);
      return json(stats);
    }

    if (path === '/state' && url.searchParams.has('slug')) {
      const slug = url.searchParams.get('slug')!;
      const state = await getScrapeState(env, slug);
      if (!state) return json({ error: 'not found' }, 404);
      return json(state);
    }

    if (path === '/admin/scrape' && request.method === 'POST') {
      const secret = request.headers.get('X-Admin-Secret');
      const expected = env.ADMIN_SECRET;

      if (!expected || secret !== expected) {
        return json({ error: 'unauthorized' }, 401);
      }

      const limit = Math.min(
        parseInt(url.searchParams.get('limit') ?? '5', 10),
        20
      );

      const result = await runScrapeManual(env, limit);
      return json({ ok: true, result });
    }

    if (path === '/admin/reset-stale' && request.method === 'POST') {
      const secret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }

      const reset = await resetStaleInProgress(env);
      return json({ ok: true, reset });
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runScrapeCron(env);
          console.log(
            `[Scheduled] done — success=${result.succeeded}, failed=${result.failed}, skipped=${result.skipped}`
          );
        } catch (err) {
          console.error('[Scheduled] failed:', err);
        }
      })()
    );
  },
} satisfies ExportedHandler<Env>;