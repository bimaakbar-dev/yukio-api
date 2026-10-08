import type {
  Env,
  ScrapeStateRow,
  ScrapeStatus,
  YukionimeListItem,
} from '../types';

const IN_PROGRESS_STALE_MS = 10 * 60 * 1000;

/* ============================================================
   YUKIONIME LIST — fetch daftar anime dari frontend
   ============================================================ */

export async function fetchYukionimeList(
  env: Env
): Promise<YukionimeListItem[]> {
  const res = await fetch(env.YUKIONIME_API, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Yukionime API HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data?: YukionimeListItem[] };
  return json.data ?? [];
}

/* ============================================================
   SEED — pastikan semua slug ada di scrape_state
   ============================================================ */

export async function seedAnimeList(
  env: Env,
  items: YukionimeListItem[]
): Promise<number> {
  if (items.length === 0) return 0;

  const now = Date.now();
  let inserted = 0;

  const existing = await env.DB
    .prepare('SELECT slug FROM scrape_state')
    .all<{ slug: string }>();

  const existingSet = new Set((existing.results ?? []).map((r) => r.slug));

  const newSlugs = items
    .map((i) => i.id)
    .filter((slug) => slug && !existingSet.has(slug));

  if (newSlugs.length === 0) return 0;

  const stmts = newSlugs.map((slug) =>
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO scrape_state
          (slug, status, file_count, files_json, attempt_count, created_at, updated_at)
         VALUES (?, 'pending', 0, '[]', 0, ?, ?)`
      )
      .bind(slug, now, now)
  );

  await env.DB.batch(stmts);
  inserted = newSlugs.length;

  return inserted;
}

/* ============================================================
   GET — ambil slug berikutnya untuk di-scrape
   ============================================================ */

interface ScrapeRowMinimal {
  slug: string;
}

export async function getNextBatch(
  env: Env,
  batchSize: number,
  incremental: boolean,
  ttlDays: number
): Promise<string[]> {
  await resetStaleInProgress(env);

  if (incremental) {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

    const res = await env.DB
      .prepare(
        `SELECT slug FROM scrape_state
         WHERE status = 'pending'
            OR (status = 'failed' AND attempt_count < 3)
            OR (status = 'success' AND (last_success_at IS NULL OR last_success_at < ?))
         ORDER BY
           CASE status
             WHEN 'pending' THEN 0
             WHEN 'failed' THEN 1
             WHEN 'success' THEN 2
             ELSE 3
           END,
           created_at ASC
         LIMIT ?`
      )
      .bind(cutoff, batchSize)
      .all<ScrapeRowMinimal>();

    return (res.results ?? []).map((r) => r.slug);
  }

  const res = await env.DB
    .prepare(
      `SELECT slug FROM scrape_state
       WHERE status = 'pending'
          OR (status = 'failed' AND attempt_count < 3)
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(batchSize)
    .all<ScrapeRowMinimal>();

  return (res.results ?? []).map((r) => r.slug);
}

/* ============================================================
   LOCK / UNLOCK
   ============================================================ */

export async function markInProgress(
  env: Env,
  slug: string
): Promise<boolean> {
  const now = Date.now();

  const res = await env.DB
    .prepare(
      `UPDATE scrape_state
       SET status = 'in_progress',
           attempt_count = attempt_count + 1,
           last_scraped_at = ?,
           updated_at = ?
       WHERE slug = ?
         AND status != 'in_progress'`
    )
    .bind(now, now, slug)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

export async function resetStaleInProgress(env: Env): Promise<number> {
  const cutoff = Date.now() - IN_PROGRESS_STALE_MS;

  const res = await env.DB
    .prepare(
      `UPDATE scrape_state
       SET status = 'failed',
           last_error = 'stale in_progress (reset by cleanup)',
           updated_at = ?
       WHERE status = 'in_progress'
         AND last_scraped_at < ?`
    )
    .bind(Date.now(), cutoff)
    .run();

  return res.meta?.changes ?? 0;
}

/* ============================================================
   MARK RESULT
   ============================================================ */

export interface MarkSuccessInput {
  slug: string;
  sourceUsed: string;
  files: string[];
}

export async function markSuccess(
  env: Env,
  input: MarkSuccessInput
): Promise<void> {
  const now = Date.now();

  await env.DB
    .prepare(
      `UPDATE scrape_state
       SET status = 'success',
           source_used = ?,
           file_count = ?,
           files_json = ?,
           last_error = NULL,
           last_success_at = ?,
           first_scraped_at = COALESCE(first_scraped_at, ?),
           updated_at = ?
       WHERE slug = ?`
    )
    .bind(
      input.sourceUsed,
      input.files.length,
      JSON.stringify(input.files),
      now,
      now,
      now,
      input.slug
    )
    .run();
}

export async function markFailed(
  env: Env,
  slug: string,
  error: string
): Promise<void> {
  const now = Date.now();
  const truncatedError = error.slice(0, 1000);

  await env.DB
    .prepare(
      `UPDATE scrape_state
       SET status = 'failed',
           last_error = ?,
           first_scraped_at = COALESCE(first_scraped_at, ?),
           updated_at = ?
       WHERE slug = ?`
    )
    .bind(truncatedError, now, now, slug)
    .run();
}

export async function markSkipped(
  env: Env,
  slug: string,
  reason: string
): Promise<void> {
  const now = Date.now();

  await env.DB
    .prepare(
      `UPDATE scrape_state
       SET status = 'skipped',
           last_error = ?,
           updated_at = ?
       WHERE slug = ?`
    )
    .bind(reason.slice(0, 500), now, slug)
    .run();
}

/* ============================================================
   STATS / READ
   ============================================================ */

export interface StatsSummary {
  total: number;
  pending: number;
  in_progress: number;
  success: number;
  failed: number;
  skipped: number;
}

export async function getStats(env: Env): Promise<StatsSummary> {
  const res = await env.DB
    .prepare(
      `SELECT status, COUNT(*) as count
       FROM scrape_state
       GROUP BY status`
    )
    .all<{ status: ScrapeStatus; count: number }>();

  const summary: StatsSummary = {
    total: 0,
    pending: 0,
    in_progress: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of res.results ?? []) {
    summary[row.status] = row.count;
    summary.total += row.count;
  }

  return summary;
}

export async function getScrapeState(
  env: Env,
  slug: string
): Promise<ScrapeStateRow | null> {
  const row = await env.DB
    .prepare('SELECT * FROM scrape_state WHERE slug = ?')
    .bind(slug)
    .first<ScrapeStateRow>();

  return row ?? null;
}

/* ============================================================
   LOG
   ============================================================ */

export interface LogInput {
  durationMs: number;
  totalAvailable: number;
  batchSize: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export async function writeLog(env: Env, input: LogInput): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO scrape_log
        (run_at, duration_ms, total_available, batch_size,
         succeeded, failed, skipped, errors_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      Date.now(),
      input.durationMs,
      input.totalAvailable,
      input.batchSize,
      input.succeeded,
      input.failed,
      input.skipped,
      JSON.stringify(input.errors.slice(0, 20))
    )
    .run();
}