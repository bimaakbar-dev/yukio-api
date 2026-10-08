// ────────────────────────────────────────────────────────
// D1 query helpers
// ────────────────────────────────────────────────────────
//
// Semua query pakai prepared statement (.prepare().bind())
// untuk mencegah SQL injection. Tidak ada string interpolation.
//
// Reference:
//   - D1 prepared statements: https://developers.cloudflare.com/d1/worker-api/prepared-statements/
//   - UPSERT syntax:          https://sqlite.org/lang_upsert.html
//   - Aggregate functions:    https://developers.cloudflare.com/d1/sql-api/sql-statements/
// ────────────────────────────────────────────────────────

import type {
  RatingRow,
  RatingAggregate,
  RatingData,
} from './types.js';

// ────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────

/**
 * Ambil agregat rating (average + vote count) untuk 1 anime.
 * Return null kalau belum ada vote sama sekali.
 *
 * SQL: SELECT AVG(score), COUNT(*) FROM ratings WHERE anime_id = ?
 */
export async function getRatingAggregate(
  db: D1Database,
  animeId: string
): Promise<RatingAggregate | null> {
  const row = await db
    .prepare(
      `SELECT
         anime_id,
         AVG(score) AS avg_score,
         COUNT(*)   AS vote_count
       FROM ratings
       WHERE anime_id = ?`
    )
    .bind(animeId)
    .first<RatingAggregate>();

  return row ?? null;
}

/**
 * Ambil rating milik 1 user untuk 1 anime.
 * Return null kalau user belum vote anime ini.
 *
 * SQL: SELECT * FROM ratings WHERE anime_id = ? AND user_id = ?
 */
export async function getUserRating(
  db: D1Database,
  animeId: string,
  userId: string
): Promise<RatingRow | null> {
  const row = await db
    .prepare(
      `SELECT anime_id, user_id, score, created_at, updated_at
       FROM ratings
       WHERE anime_id = ? AND user_id = ?`
    )
    .bind(animeId, userId)
    .first<RatingRow>();

  return row ?? null;
}

/**
 * Ambil data rating lengkap untuk 1 anime dalam 1 round-trip:
 * agregat + rating user (kalau ada).
 *
 * Return RatingData yang siap dipakai sebagai response API.
 *
 * Catatan: query dijalankan berurutan (bukan paralel) karena
 * D1 batch() tidak support campuran SELECT + parameter bind
 * yang berbeda. Untuk 2 query kecil ini, serial OK.
 */
export async function getRatingData(
  db: D1Database,
  animeId: string,
  userId: string
): Promise<RatingData> {
  const [aggregate, userRating] = await Promise.all([
    getRatingAggregate(db, animeId),
    getUserRating(db, animeId, userId),
  ]);

  const rawAvg = aggregate?.avg_score ?? 0;
  const votes  = aggregate?.vote_count ?? 0;

  // Konversi skala 1-5 → 1-10.
  // Kalau belum ada vote, average = 0 (bukan null) agar
  // frontend bisa handle dengan `if (average > 0)`.
  const average = votes > 0
    ? Math.round(rawAvg * 2 * 10) / 10
    : 0;

  return {
    animeId,
    average,
    votes,
    userScore: userRating?.score ?? null,
  };
}

/**
 * Ambil semua rating (untuk endpoint /api/v1/ratings).
 * Berguna untuk sync / audit.
 *
 * SQL: SELECT anime_id, AVG(score), COUNT(*) FROM ratings GROUP BY anime_id
 */
export async function getAllRatings(
  db: D1Database
): Promise<Array<{ anime_id: string; avg_score: number; vote_count: number }>> {
  const result = await db
    .prepare(
      `SELECT
         anime_id,
         AVG(score) AS avg_score,
         COUNT(*)   AS vote_count
       FROM ratings
       GROUP BY anime_id
       ORDER BY anime_id`
    )
    .all<{ anime_id: string; avg_score: number; vote_count: number }>();

  return result.results ?? [];
}

// ────────────────────────────────────────────────────────
// Write
// ────────────────────────────────────────────────────────

/**
 * Insert atau update rating user untuk 1 anime.
 * Pakai UPSERT (INSERT ... ON CONFLICT ... DO UPDATE).
 *
 * Composite PK (anime_id, user_id) menjamin 1 vote per user per anime.
 * Kalau sudah ada, score & updated_at di-overwrite.
 *
 * Return row yang baru tersimpan (untuk verifikasi).
 *
 * Reference UPSERT SQLite:
 *   https://sqlite.org/lang_upsert.html
 */
export async function upsertRating(
  db: D1Database,
  animeId: string,
  userId: string,
  score: number
): Promise<RatingRow> {
  const now = Date.now();

  const result = await db
    .prepare(
      `INSERT INTO ratings (anime_id, user_id, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (anime_id, user_id) DO UPDATE
         SET score      = excluded.score,
             updated_at = excluded.updated_at`
    )
    .bind(animeId, userId, score, now, now)
    .run();

  if (!result.success) {
    throw new Error(`Failed to upsert rating: ${result.error ?? 'unknown'}`);
  }

  const saved = await getUserRating(db, animeId, userId);
  if (!saved) {
    throw new Error('Upsert succeeded but row not found');
  }

  return saved;
}

/**
 * Hapus rating user untuk 1 anime.
 * Return true kalau ada row yang dihapus, false kalau tidak ada.
 */
export async function deleteRating(
  db: D1Database,
  animeId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ratings WHERE anime_id = ? AND user_id = ?`
    )
    .bind(animeId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}