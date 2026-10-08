-- ────────────────────────────────────────────────────────
-- Migration: 0002_scrape_state
-- Description: Tabel progress scraping anime → yukio-data
-- Created: 2026-10-08
-- ────────────────────────────────────────────────────────
--
-- Tabel ini menyimpan state scraping per anime:
--   - Apa yang sudah pernah di-scrape
--   - Kapan terakhir sukses
--   - Berapa kali gagal
--   - File apa saja yang sudah di-push
--
-- Dipakai untuk:
--   - Skip anime yang sudah sukses (mode INCREMENTAL)
--   - Retry anime yang gagal (max N attempts)
--   - Resume setelah worker restart
--   - Log audit
-- ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scrape_state (
  -- Slug anime (dari yukionime URL: /anime/[slug]/)
  slug              TEXT    PRIMARY KEY,

  -- Status: pending | in_progress | success | failed | skipped
  --   pending      = belum pernah dicoba
  --   in_progress  = sedang diproses (lock untuk cegah double)
  --   success      = pernah sukses (kapan terakhir di last_success_at)
  --   failed       = pernah gagal (lihat last_error & attempt_count)
  --   skipped      = sengaja diskip (mis. anime draft)
  status            TEXT    NOT NULL DEFAULT 'pending',

  -- Sumber yang dipakai saat sukses (AniList / Shikimori / Kitsu)
  source_used       TEXT,

  -- Jumlah file yang berhasil di-push ke yukio-data
  file_count        INTEGER NOT NULL DEFAULT 0,

  -- JSON array path file yang sudah di-push
  -- Contoh: ["src/content/anime/naruto.md", "data/anime/naruto/characters/1-50.json"]
  files_json        TEXT    NOT NULL DEFAULT '[]',

  -- Berapa kali sudah dicoba
  attempt_count     INTEGER NOT NULL DEFAULT 0,

  -- Error terakhir (kalau status = failed)
  last_error        TEXT,

  -- Timestamps (Unix ms)
  first_scraped_at  INTEGER,
  last_scraped_at   INTEGER,
  last_success_at   INTEGER,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Index untuk query "mana yang perlu di-scrape berikutnya"
-- Query: SELECT * FROM scrape_state WHERE status = 'pending' ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_scrape_state_status
  ON scrape_state (status, created_at);

-- Index untuk cek anime yang sudah sukses (mode incremental)
CREATE INDEX IF NOT EXISTS idx_scrape_state_success
  ON scrape_state (status, last_success_at DESC);

-- ────────────────────────────────────────────────────────
-- Tabel log per-run (ringkasan eksekusi cron)
-- ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scrape_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at          INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL DEFAULT 0,

  -- Batch info
  total_available INTEGER NOT NULL DEFAULT 0,  -- total anime pending
  batch_size      INTEGER NOT NULL DEFAULT 0,  -- yang diproses di run ini

  -- Hasil
  succeeded       INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,

  -- Errors (JSON array string)
  errors_json     TEXT    NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_scrape_log_run_at
  ON scrape_log (run_at DESC);