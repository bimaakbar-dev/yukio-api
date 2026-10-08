import type {
  Env,
  UnifiedVoiceActor,
  FileToCommit,
} from '../types';
import {
  fetchAniListTop,
  fetchAniListById,
  fetchCharactersFromAniList,
  fetchRelationsFromShikimori,
  fetchEpisodesFromKitsu,
  searchKitsuId,
  slugify,
} from '../lib/sources';
import { buildAll } from '../lib/transform';
import { githubCommitMultipleFiles, githubGetFile } from '../lib/github';
import {
  getMeta,
  setMeta,
  insertQueue,
  getQueuePendingCount,
  nextQueueItem,
  markQueueInProgress,
  deleteQueueItem,
  markQueueFailed,
  getQueueStats,
} from '../lib/state';

const REFILL_THRESHOLD = 100;
const DEFAULT_MAX_EPISODES = 100;
const DEFAULT_MAX_CHARACTERS = 100;

/* ============================================================
   REFILL — fetch dari AniList, insert ke queue
   ============================================================ */

async function refillQueue(env: Env): Promise<number> {
  const nextPageStr = await getMeta(env, 'next_page');
  let nextPage = parseInt(nextPageStr ?? '1', 10);

  const sortKey = env.ANILIST_SORT || 'popular';

  console.log(`[Refill] fetch page ${nextPage}, sort=${sortKey}`);

  const items = await fetchAniListTop(nextPage, sortKey);

  if (items.length === 0) {
    console.log('[Refill] no more items from AniList');
    return 0;
  }

  const insertItems = items.map((item) => {
    const title =
      item.title.romaji || item.title.english || item.title.native || 'Unknown';
    const slug = slugify(title) || `anilist-${item.id}`;
    return {
      anilistId: item.id,
      slug,
      title,
    };
  });

  const inserted = await insertQueue(env, insertItems);

  nextPage++;

  await Promise.all([
    setMeta(env, 'next_page', String(nextPage)),
    setMeta(
      env,
      'total_fetched',
      String((await getMetaTotal(env)) + items.length)
    ),
  ]);

  console.log(`[Refill] inserted ${inserted} (page ${nextPage - 1})`);
  return inserted;
}

async function getMetaTotal(env: Env): Promise<number> {
  const v = await getMeta(env, 'total_fetched');
  return parseInt(v ?? '0', 10);
}

/* ============================================================
   SCRAPE ONE — fetch detail, build, push
   ============================================================ */

interface ScrapeResult {
  ok: boolean;
  fileCount: number;
  sourceUsed: string;
  error?: string;
  voiceActors: UnifiedVoiceActor[];
}

async function scrapeOne(
  env: Env,
  slug: string,
  anilistId: number,
  title: string
): Promise<ScrapeResult> {
  const t0 = Date.now();
  const log = (msg: string) =>
    console.log(`[Scrape:${slug}] ${msg} (+${Date.now() - t0}ms)`);

  log('start');

  const media = await fetchAniListById(anilistId);
  if (!media) {
    return {
      ok: false,
      fileCount: 0,
      sourceUsed: 'anilist',
      error: 'AniList metadata not found',
      voiceActors: [],
    };
  }

  log('metadata ok');

  const malId = media.myanimelistId ?? null;

  const kitsuId = await searchKitsuId(title).catch(() => null);
  log(`kitsu: ${kitsuId ?? 'none'}`);

  const maxChars = parseInt(
    env.MAX_CHARACTERS ?? String(DEFAULT_MAX_CHARACTERS),
    10
  );
  const maxEps = parseInt(
    env.MAX_EPISODES ?? String(DEFAULT_MAX_EPISODES),
    10
  );

  const [charsResult, relationsResult, episodesResult] = await Promise.all([
    malId
      ? fetchCharactersFromAniList(malId, maxChars).catch(() => null)
      : Promise.resolve(null),
    malId
      ? fetchRelationsFromShikimori(malId).catch(() => null)
      : Promise.resolve(null),
    kitsuId
      ? fetchEpisodesFromKitsu(kitsuId, maxEps).catch(() => null)
      : Promise.resolve(null),
  ]);

  const characters = charsResult?.characters ?? [];
  const voiceActors = charsResult?.voiceActors ?? [];
  const relations = relationsResult ?? [];
  const episodes = episodesResult ?? [];

  log(
    `fetched: chars=${characters.length}, VA=${voiceActors.length}, rel=${relations.length}, eps=${episodes.length}`
  );

  const rawSynopsis = media.description ?? '';
  const synopsis = stripHtml(rawSynopsis) || '> ⚠️ Sinopsis belum tersedia.';

  const built = buildAll({
    slug,
    media,
    malId,
    kitsuId,
    synopsis,
    characters,
    episodes,
    relations,
    voiceActors,
  });

  const markdownPath = `src/content/anime/${slug}.md`;
  const animeFiles: FileToCommit[] = [
    { path: markdownPath, content: built.markdown },
    ...built.animeFiles,
  ];

  log(`built: ${animeFiles.length} files`);

  const commitMsg = `feat(${slug}): scrape from AniList`;

  const commitResult = await githubCommitMultipleFiles(
    env,
    animeFiles,
    commitMsg
  );

  if (!commitResult.ok) {
    log(`commit FAILED: ${commitResult.error}`);
    return {
      ok: false,
      fileCount: 0,
      sourceUsed: 'anilist',
      error: commitResult.error ?? 'commit failed',
      voiceActors,
    };
  }

  log(`commit OK: ${commitResult.sha?.slice(0, 7)}`);

  return {
    ok: true,
    fileCount: animeFiles.length,
    sourceUsed: 'anilist',
    voiceActors,
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================================================
   MERGE ACTOR FILES
   ============================================================ */

async function mergeActorFiles(
  env: Env,
  incoming: UnifiedVoiceActor[]
): Promise<{ ok: boolean; files: number; error?: string }> {
  if (incoming.length === 0) return { ok: true, files: 0 };

  const grouped = new Map<string, UnifiedVoiceActor[]>();
  for (const va of incoming) {
    const first = (va.id.charAt(0) || '').toLowerCase();
    const letter = /^[a-z]$/.test(first) ? first : '_';
    if (!grouped.has(letter)) grouped.set(letter, []);
    grouped.get(letter)!.push(va);
  }

  const filesToCommit: FileToCommit[] = [];

  for (const [letter, list] of grouped) {
    const path = `data/actors/${letter}.json`;
    const existing = await githubGetFile(env, path);

    const map = new Map<string, UnifiedVoiceActor>();
    if (existing) {
      try {
        const parsed = JSON.parse(existing.content) as UnifiedVoiceActor[];
        if (Array.isArray(parsed)) {
          for (const va of parsed) if (va?.id) map.set(va.id, va);
        }
      } catch {}
    }

    let newCount = 0;
    for (const va of list) {
      if (map.has(va.id)) {
        const old = map.get(va.id)!;
        const merged: UnifiedVoiceActor = {
          ...old,
          ...Object.fromEntries(
            Object.entries(va).filter(([, v]) => v != null && v !== '')
          ),
        };
        map.set(va.id, merged);
      } else {
        map.set(va.id, va);
        newCount++;
      }
    }

    if (newCount === 0 && existing) continue;

    const sorted = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
    filesToCommit.push({
      path,
      content: JSON.stringify(sorted, null, 2) + '\n',
    });
  }

  if (filesToCommit.length === 0) return { ok: true, files: 0 };

  const result = await githubCommitMultipleFiles(
    env,
    filesToCommit,
    `chore(actors): update ${filesToCommit.length} file(s)`
  );

  if (!result.ok) return { ok: false, files: 0, error: result.error };
  return { ok: true, files: filesToCommit.length };
}

/* ============================================================
   MAIN RUN
   ============================================================ */

export interface CronRunResult {
  refilled: number;
  processed: number;
  succeeded: number;
  failed: number;
  actorFilesUpdated: number;
  queuePending: number;
  queueTotal: number;
  nextPage: number;
  errors: string[];
}

export async function runScrapeCron(env: Env): Promise<CronRunResult> {
  const t0 = Date.now();
  const log = (msg: string) =>
    console.log(`[Cron] ${msg} (+${Date.now() - t0}ms)`);

  log('start');

  const result: CronRunResult = {
    refilled: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    actorFilesUpdated: 0,
    queuePending: 0,
    queueTotal: 0,
    nextPage: 1,
    errors: [],
  };

  /* ── 1. Refill kalau queue < threshold ────────── */
  try {
    const pending = await getQueuePendingCount(env);
    if (pending < REFILL_THRESHOLD) {
      const inserted = await refillQueue(env);
      result.refilled = inserted;
    }
  } catch (err) {
    const msg = (err as Error).message ?? 'refill failed';
    log(`refill error: ${msg}`);
    result.errors.push(`refill: ${msg}`);
  }

  /* ── 2. Ambil 1 item ──────────────────────────── */
  const item = await nextQueueItem(env);

  if (!item) {
    log('queue empty, exit');
    const stats = await getQueueStats(env);
    result.queuePending = stats.pending;
    result.queueTotal = stats.total;
    result.nextPage = stats.next_page;
    return result;
  }

  const locked = await markQueueInProgress(env, item.id);
  if (!locked) {
    log(`item ${item.id} already locked, exit`);
    return result;
  }

  log(`processing [${item.id}] ${item.slug}`);

  /* ── 3. Scrape ────────────────────────────────── */
  let scrapeResult: ScrapeResult;

  try {
    scrapeResult = await scrapeOne(
      env,
      item.slug,
      item.anilist_id,
      item.title
    );
  } catch (err) {
    scrapeResult = {
      ok: false,
      fileCount: 0,
      sourceUsed: 'unknown',
      error: (err as Error).message ?? 'unknown',
      voiceActors: [],
    };
  }

  result.processed = 1;

  /* ── 4. Sukses → DELETE dari queue ────────────── */
  if (scrapeResult.ok) {
    await deleteQueueItem(env, item.id);
    result.succeeded = 1;
    log(`✓ ${item.slug} deleted from queue`);

    if (scrapeResult.voiceActors.length > 0) {
      const actorResult = await mergeActorFiles(env, scrapeResult.voiceActors);
      if (actorResult.ok) {
        result.actorFilesUpdated = actorResult.files;
      } else {
        result.errors.push(`actors: ${actorResult.error}`);
      }
    }
  } else {
    await markQueueFailed(env, item.id, scrapeResult.error ?? 'unknown');
    result.failed = 1;
    result.errors.push(`${item.slug}: ${scrapeResult.error}`);
    log(`✗ ${item.slug} — ${scrapeResult.error}`);
  }

  /* ── 5. Stats akhir ───────────────────────────── */
  const stats = await getQueueStats(env);
  result.queuePending = stats.pending;
  result.queueTotal = stats.total;
  result.nextPage = stats.next_page;

  log(
    `done - refilled=${result.refilled}, ok=${result.succeeded}, fail=${result.failed}, pending=${stats.pending}, page=${stats.next_page} (${Date.now() - t0}ms)`
  );

  return result;
}