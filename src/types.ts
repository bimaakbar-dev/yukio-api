// ────────────────────────────────────────────────────────
// Types untuk Worker yukio-api
// ────────────────────────────────────────────────────────
//
// Konvensi:
//   - Env: binding & vars dari wrangler.toml
//   - RatingRow: bentuk baris di tabel `ratings` (snake_case)
//   - RatingResponse: bentuk response API ke frontend (camelCase)
//   - ApiSuccess/ApiError: envelope response standar
// ────────────────────────────────────────────────────────

/**
 * Environment bindings & variables.
 * Nama property HARUS cocok dengan binding di wrangler.toml.
 */
export interface Env {
  /** D1 database binding. Nama "DB" sesuai wrangler.toml. */
  DB: D1Database;

  /** Origin yang diizinkan CORS, dipisah koma. Dari wrangler.toml [vars]. */
  ALLOWED_ORIGINS: string;
}

/**
 * Bentuk baris tabel `ratings` (snake_case, sesuai schema.sql).
 * Timestamp: Unix milliseconds (INTEGER).
 */
export interface RatingRow {
  anime_id: string;
  user_id: string;
  score: number;
  created_at: number;
  updated_at: number;
}

/**
 * Hasil agregat: rata-rata + jumlah vote untuk 1 anime.
 * Bentuk dari query: SELECT AVG(score) as avg_score, COUNT(*) as vote_count
 */
export interface RatingAggregate {
  anime_id: string;
  avg_score: number | null;
  vote_count: number;
}

/**
 * Response API ke frontend.
 * `average` = skala 1-10 (hasil konversi dari rata-rata 1-5 × 2).
 * `votes`   = jumlah voter.
 * `userScore` = skor user (1-5) kalau ada, null kalau belum vote.
 */
export interface RatingData {
  animeId: string;
  average: number;
  votes: number;
  userScore: number | null;
}

/**
 * Envelope response sukses.
 */
export interface ApiSuccess<T> {
  data: T;
  meta: {
    version: string;
    generatedAt: string;
    [key: string]: unknown;
  };
}

/**
 * Envelope response error.
 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    status: number;
  };
}

/**
 * Konteks internal setelah auth cookie divalidasi/di-generate.
 * Dipakai di handler supaya tidak perlu parse cookie berulang.
 */
export interface RequestContext {
  /** User ID dari cookie `vid`. */
  userId: string;
  /** true kalau cookie baru di-generate (perlu di-set di response). */
  isNewUser: boolean;
  /** Origin request (untuk CORS). */
  origin: string | null;
}