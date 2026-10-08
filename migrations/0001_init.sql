-- ────────────────────────────────────────────────────────
-- Migration: 0001_init
-- Description: Tabel ratings untuk sistem rating anime
-- Created: 2026-10-08
-- ────────────────────────────────────────────────────────
--
-- Konvensi:
--   - Timestamp: INTEGER Unix milliseconds (bukan ISO string,
--     bukan seconds). Lihat catatan di bawah.
--   - score: 1-5 (bukan 1-10). Frontend kirim 1-5, display
--     konversi ke /10 di UI.
--   - user_id: dari cookie `vid` yang di-generate Worker.
-- ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ratings (
  anime_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Composite PK: 1 vote per user per anime.
  -- Vote kedua = UPSERT (update score + updated_at).
  -- Mencegah spam duplicate.
  PRIMARY KEY (anime_id, user_id)
);

-- Index untuk query agregat per anime (hitung average + jumlah vote).
-- Query: SELECT AVG(score), COUNT(*) FROM ratings WHERE anime_id = ?
CREATE INDEX IF NOT EXISTS idx_ratings_anime
  ON ratings (anime_id);

-- Index untuk listing anime terbaru yang di-rate.
-- Query: SELECT * FROM ratings ORDER BY updated_at DESC LIMIT n
CREATE INDEX IF NOT EXISTS idx_ratings_updated
  ON ratings (updated_at DESC);