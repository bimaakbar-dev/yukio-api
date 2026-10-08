import type { Env, ScrapeQueueRow } from '../types';

const IN_PROGRESS_STALE_MS = 10 * 60 * 1000;

/* ============================================================
   META
   ============================================================ */

export async function getMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB
    .prepare('SELECT value FROM scrape_meta WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();

  return row?.value ?? null;
}

export async function setMeta(
  env: Env,
  key: string,
  value: string
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO scrape_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .bind(key, value, Date.now())
    .run();
}

/* ============================================================
   QUEUE — INSERT (refill)
   ============================================================ */

export interface QueueInsertItem {
  anilistId: number;
  slug: string;
  title: string;
}

export async function insertQueue(
  env: Env,
  items: QueueInsertItem[]
): Promise<number> {
  if (items.length === 0) return 0;

  const now = Date.now();

  const stmts = items.map((item) =>
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO scrape_queue
          (anilist_id, slug, title, status, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`
      )
      .bind(item.anilistId, item.slug, item.title, now, now)
  );

  await env.DB.batch(stmts);

  return items.length;
}

/* ============================================================
   QUEUE — AMBIL NEXT
   ============================================================ */

export async function getQueuePendingCount(env: Env): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) as c FROM scrape_queue
       WHERE status = 'pending' OR (status = 'failed' AND attempt_count < 3)`
    )
    .first<{ c: number }>();

  return row?.c ?? 0;
}

export async function getQueueTotal(env: Env): Promise<number> {
  const row = await env.DB
    .prepare('SELECT COUNT(*) as c FROM scrape_queue')
    .first<{ c: number }>();

  return row?.c ?? 0;
}

export async function resetStaleInProgress(env: Env): Promise<number> {
  const cutoff = Date.now() - IN_PROGRESS_STALE_MS;

  const res = await env.DB
    .prepare(
      `UPDATE scrape_queue
       SET status = 'pending',
           last_error = 'stale in_progress (auto reset)',
           updated_at = ?
       WHERE status = 'in_progress'
         AND updated_at < ?`
    )
    .bind(Date.now(), cutoff)
    .run();

  return res.meta?.changes ?? 0;
}

export async function nextQueueItem(env: Env): Promise<ScrapeQueueRow | null> {
  await resetStaleInProgress(env);

  const row = await env.DB
    .prepare(
      `SELECT * FROM scrape_queue
       WHERE status = 'pending'
          OR (status = 'failed' AND attempt_count < 3)
       ORDER BY
         CASE status
           WHEN 'pending' THEN 0
           WHEN 'failed' THEN 1
           ELSE 2
         END,
         id ASC
       LIMIT 1`
    )
    .first<ScrapeQueueRow>();

  return row ?? null;
}

export async function markQueueInProgress(
  env: Env,
  id: number
): Promise<boolean> {
  const now = Date.now();

  const res = await env.DB
    .prepare(
      `UPDATE scrape_queue
       SET status = 'in_progress',
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status != 'in_progress'`
    )
    .bind(now, id)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

/* ============================================================
   QUEUE — HAPUS (sukses)
   ============================================================ */

export async function deleteQueueItem(env: Env, id: number): Promise<void> {
  await env.DB
    .prepare('DELETE FROM scrape_queue WHERE id = ?')
    .bind(id)
    .run();
}

/* ============================================================
   QUEUE — MARK FAILED
   ============================================================ */

export async function markQueueFailed(
  env: Env,
  id: number,
  error: string
): Promise<void> {
  const truncated = error.slice(0, 1000);
  const now = Date.now();

  await env.DB
    .prepare(
      `UPDATE scrape_queue
       SET status = 'failed',
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(truncated, now, id)
    .run();
}

/* ============================================================
   STATS
   ============================================================ */

export interface QueueStats {
  total: number;
  pending: number;
  in_progress: number;
  failed: number;
  failed_permanent: number;
  total_fetched: number;
  next_page: number;
}

export async function getQueueStats(env: Env): Promise<QueueStats> {
  const [counts, metaFetched, metaPage] = await Promise.all([
    env.DB
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
           SUM(CASE WHEN status = 'failed' AND attempt_count < 3 THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'failed' AND attempt_count >= 3 THEN 1 ELSE 0 END) as failed_permanent
         FROM scrape_queue`
      )
      .first<{
        total: number;
        pending: number;
        in_progress: number;
        failed: number;
        failed_permanent: number;
      }>(),
    getMeta(env, 'total_fetched'),
    getMeta(env, 'next_page'),
  ]);

  const c = counts ?? {
    total: 0,
    pending: 0,
    in_progress: 0,
    failed: 0,
    failed_permanent: 0,
  };

  return {
    total: c.total ?? 0,
    pending: c.pending ?? 0,
    in_progress: c.in_progress ?? 0,
    failed: c.failed ?? 0,
    failed_permanent: c.failed_permanent ?? 0,
    total_fetched: parseInt(metaFetched ?? '0', 10),
    next_page: parseInt(metaPage ?? '1', 10),
  };
}

/* ============================================================
   RESET — untuk admin manual
   ============================================================ */

export async function resetPermanentFailed(env: Env): Promise<number> {
  const res = await env.DB
    .prepare(
      `UPDATE scrape_queue
       SET status = 'pending',
           attempt_count = 0,
           last_error = NULL,
           updated_at = ?
       WHERE status = 'failed' AND attempt_count >= 3`
    )
    .bind(Date.now())
    .run();

  return res.meta?.changes ?? 0;
}