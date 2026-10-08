import type {
  RatingRow,
  RatingAggregate,
  RatingData,
} from './types.js';

const M_THRESHOLD = 10;
const DEFAULT_GLOBAL = 3.0;
const GLOBAL_CACHE_TTL = 5 * 60 * 1000;

let globalCache: { value: number; ts: number } | null = null;

export async function getRatingAggregate(
  db: D1Database,
  animeId: string
): Promise<RatingAggregate | null> {
  const row = await db
    .prepare(
      `SELECT anime_id, AVG(score) AS avg_score, COUNT(*) AS vote_count
       FROM ratings
       WHERE anime_id = ?`
    )
    .bind(animeId)
    .first<RatingAggregate>();

  return row ?? null;
}

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

export async function getGlobalAverage(db: D1Database): Promise<number> {
  const now = Date.now();

  if (globalCache && now - globalCache.ts < GLOBAL_CACHE_TTL) {
    return globalCache.value;
  }

  const row = await db
    .prepare(`SELECT AVG(score) AS avg_score FROM ratings`)
    .first<{ avg_score: number | null }>();

  const value =
    row?.avg_score != null && row.avg_score > 0 ? row.avg_score : DEFAULT_GLOBAL;

  globalCache = { value, ts: now };
  return value;
}

export function computeWeighted(
  rawAvg: number,
  votes: number,
  globalAvg: number,
  m: number = M_THRESHOLD
): number {
  if (votes <= 0) return 0;
  return (votes / (votes + m)) * rawAvg + (m / (votes + m)) * globalAvg;
}

export async function getRatingData(
  db: D1Database,
  animeId: string,
  userId: string
): Promise<RatingData> {
  const [aggregate, userRating, globalAvg] = await Promise.all([
    getRatingAggregate(db, animeId),
    getUserRating(db, animeId, userId),
    getGlobalAverage(db),
  ]);

  const rawAvg = aggregate?.avg_score ?? 0;
  const votes = aggregate?.vote_count ?? 0;

  const weighted = computeWeighted(rawAvg, votes, globalAvg);

  const average = votes > 0 ? Math.round(weighted * 2 * 10) / 10 : 0;
  const rawAverage = votes > 0 ? Math.round(rawAvg * 2 * 10) / 10 : 0;

  return {
    animeId,
    average,
    rawAverage,
    votes,
    userScore: userRating?.score ?? null,
    provisional: votes > 0 && votes < M_THRESHOLD,
  };
}

export async function getAllRatings(
  db: D1Database
): Promise<
  Array<{
    anime_id: string;
    average: number;
    rawAverage: number;
    votes: number;
    provisional: boolean;
  }>
> {
  const [result, globalAvg] = await Promise.all([
    db
      .prepare(
        `SELECT anime_id, AVG(score) AS avg_score, COUNT(*) AS vote_count
         FROM ratings
         GROUP BY anime_id
         ORDER BY anime_id`
      )
      .all<{ anime_id: string; avg_score: number; vote_count: number }>(),
    getGlobalAverage(db),
  ]);

  const rows = result.results ?? [];

  return rows.map((r) => {
    const weighted = computeWeighted(r.avg_score, r.vote_count, globalAvg);
    return {
      anime_id: r.anime_id,
      average: Math.round(weighted * 2 * 10) / 10,
      rawAverage: Math.round(r.avg_score * 2 * 10) / 10,
      votes: r.vote_count,
      provisional: r.vote_count < M_THRESHOLD,
    };
  });
}

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
         SET score = excluded.score, updated_at = excluded.updated_at`
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

export async function deleteRating(
  db: D1Database,
  animeId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM ratings WHERE anime_id = ? AND user_id = ?`)
    .bind(animeId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}