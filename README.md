<div align="center">

[![Cron Scrape](https://github.com/bimaakbar-dev/yukio-api/actions/workflows/scrape.yml/badge.svg)](https://github.com/bimaakbar-dev/yukio-api/actions/workflows/scrape.yml)

<h1>YUKIO SCRAPPER</h1>

</div>

Anime scraper untuk [Yukionime](https://yukionime.pages.dev).

Fetch metadata + characters + voice actors + episodes + franchises dari
AniList/Shikimori/Kitsu, push ke repo yukio-data.

---

## Cara Kerja

[text]
[ Cron tiap 10 menit ]
        │
        ▼
[ yukio-api Worker ]
        │
        ├─ Fetch daftar anime dari yukionime API
        ├─ Ambil batch 8 anime yang belum di-scrape
        ├─ Untuk tiap anime:
        │     ├─ Chain: AniList → Shikimori → Kitsu
        │     ├─ Fetch chars + VA + relations + episodes
        │     ├─ Generate sinopsis (AI kalau perlu)
        │     └─ Push ke yukio-data
        └─ Log progress ke D1
[]

Setelah semua anime selesai di-scrape, worker bisa dimatikan atau
cron di-comment di wrangler.toml.

---

## Endpoint

| Method | Path | Fungsi |
|--------|------|--------|
| GET | / | Health check |
| GET | /stats | Ringkasan progress scraping |
| GET | /state?slug=naruto | Detail state 1 anime |
| POST | /admin/scrape?limit=5 | Trigger manual (butuh X-Admin-Secret) |
| POST | /admin/reset-stale | Reset yang stuck (butuh secret) |

---

## Setup

### 1. Install

[bash]
npm install
[]

### 2. Set secrets

[bash]
npx wrangler secret put GH_TOKEN       # fine-grained PAT, akses yukio-data
npx wrangler secret put ADMIN_SECRET   # string random (opsional)
[]

### 3. Update wrangler.toml

Isi database_id dengan UUID D1 kamu.

### 4. Apply migration

[bash]
npm run db:init
[]

### 5. Deploy

[bash]
npm run deploy
[]

---

## Cek Progress

[bash]
curl https://yukio-api.bimaakbar.workers.dev/stats
curl "https://yukio-api.bimaakbar.workers.dev/state?slug=naruto"
[]

---

## Manual Trigger

[bash]
curl -X POST "https://yukio-api.bimaakbar.workers.dev/admin/scrape?limit=5" \
  -H "X-Admin-Secret: <secret>"
[]

---

## Disable Setelah Selesai

Kalau semua anime sudah di-scrape:

### Opsi A — Comment cron

Edit wrangler.toml:

[toml]
[triggers]
# crons = ["*/10 * * * *"]
[]

Deploy ulang.

### Opsi B — Hapus worker

Dashboard Cloudflare → Workers & Pages → yukio-api → Delete.

---

## Sumber Data

- [AniList](https://anilist.co) (via proxy yukio-db.val.run)
- [Shikimori](https://shikimori.one)
- [Kitsu](https://kitsu.io)

---

## Lisensi

Data: CC BY 4.0. Lihat [yukionime](https://github.com/bimaakbar-dev/yukionime)
untuk lisensi lengkap.