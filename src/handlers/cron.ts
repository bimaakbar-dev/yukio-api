import type { Env, UnifiedVoiceActor, FileToCommit } from '../types';
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

async function refillQueue(env: Env): Promise<number> {
  const startPage = parseInt(env.START_PAGE ?? '1', 10);
  const step = parseInt(env.PAGE_STEP ?? '1', 10);
  const sortKey = env.ANILIST_SORT || 'popular';

  const currentMeta = await getMeta(env, 'next_page');
  const nextPage = parseInt(currentMeta ?? String(startPage), 10);

  const items = await fetchAniListTop(nextPage, sortKey);

  if (items.length === 0) return 0;

  const inserts = items.map((item) => {
    const title =
      item.title.romaji || item.title.english || item.title.native || 'Unknown';
    return {
      anilistId: item.id,
      slug: slugify(title) || `anilist-${item.id}`,
      title,
    };
  });

  await insertQueue(env, inserts);

  const totalStr = (await getMeta(env, 'total_fetched')) ?? '0';
  const total = parseInt(totalStr, 10) + items.length;

  await setMeta(env, 'next_page', String(nextPage + step));
  await setMeta(env, 'total_fetched', String(total));

  return inserts.length;
}

interface ScrapeResult {
  ok: boolean;
  fileCount: number;
  error?: string;
  voiceActors: UnifiedVoiceActor[];
}

async function scrapeOne(
  env: Env,
  slug: string,
  anilistId: number,
  title: string
): Promise<ScrapeResult> {
  const media = await fetchAniListById(anilistId);
  if (!media) {
    return { ok: false, fileCount: 0, error: 'anilist not found', voiceActors: [] };
  }

  const malId = media.myanimelistId ?? null;
  const kitsuId = await searchKitsuId(title).catch(() => null);

  const maxChars = parseInt(env.MAX_CHARACTERS ?? String(DEFAULT_MAX_CHARACTERS), 10);
  const maxEps = parseInt(env.MAX_EPISODES ?? String(DEFAULT_MAX_EPISODES), 10);

  const [chars, rels, eps] = await Promise.all([
    malId ? fetchCharactersFromAniList(malId, maxChars).catch(() => null) : null,
    malId ? fetchRelationsFromShikimori(malId).catch(() => null) : null,
    kitsuId ? fetchEpisodesFromKitsu(kitsuId, maxEps).catch(() => null) : null,
  ]);

  const built = buildAll({
    slug,
    media,
    malId,
    kitsuId,
    synopsis: stripHtml(media.description ?? '') || '> ⚠️ Sinopsis belum tersedia.',
    characters: chars?.characters ?? [],
    episodes: eps ?? [],
    relations: rels ?? [],
    voiceActors: chars?.voiceActors ?? [],
  });

  const files: FileToCommit[] = [
    { path: `src/content/anime/${slug}.md`, content: built.markdown },
    ...built.animeFiles,
  ];

  const result = await githubCommitMultipleFiles(
    env,
    files,
    `feat(${slug}): scrape from AniList`
  );

  if (!result.ok) {
    return {
      ok: false,
      fileCount: 0,
      error: result.error ?? 'commit failed',
      voiceActors: chars?.voiceActors ?? [],
    };
  }

  return {
    ok: true,
    fileCount: files.length,
    voiceActors: chars?.voiceActors ?? [],
  };
}

async function mergeActorFiles(
  env: Env,
  incoming: UnifiedVoiceActor[]
): Promise<{ ok: boolean; files: number; error?: string }> {
  if (incoming.length === 0) return { ok: true, files: 0 };

  const grouped = new Map<string, UnifiedVoiceActor[]>();
  for (const va of incoming) {
    const letter = /^[a-z]$/.test(va.id[0]?.toLowerCase() ?? '')
      ? va.id[0]!.toLowerCase()
      : '_';
    if (!grouped.has(letter)) grouped.set(letter, []);
    grouped.get(letter)!.push(va);
  }

  const files: FileToCommit[] = [];

  for (const [letter, list] of grouped) {
    const path = `data/actors/${letter}.json`;
    const existing = await githubGetFile(env, path);

    const map = new Map<string, UnifiedVoiceActor>();
    if (existing) {
      try {
        for (const va of JSON.parse(existing.content) as UnifiedVoiceActor[]) {
          if (va?.id) map.set(va.id, va);
        }
      } catch {}
    }

    let newCount = 0;
    for (const va of list) {
      if (map.has(va.id)) {
        const old = map.get(va.id)!;
        map.set(va.id, {
          ...old,
          ...Object.fromEntries(
            Object.entries(va).filter(([, v]) => v != null && v !== '')
          ),
        });
      } else {
        map.set(va.id, va);
        newCount++;
      }
    }

    if (newCount === 0 && existing) continue;

    files.push({
      path,
      content: JSON.stringify(
        [...map.values()].sort((a, b) => a.id.localeCompare(b.id)),
        null,
        2
      ) + '\n',
    });
  }

  if (files.length === 0) return { ok: true, files: 0 };

  const r = await githubCommitMultipleFiles(
    env,
    files,
    `chore(actors): update ${files.length} file(s)`
  );

  return r.ok ? { ok: true, files: files.length } : { ok: false, files: 0, error: r.error };
}

export interface CronRunResult {
  refilled: number;
  succeeded: number;
  failed: number;
  actorFilesUpdated: number;
  queuePending: number;
  queueTotal: number;
  nextPage: number;
  errors: string[];
}

export async function runScrapeCron(env: Env): Promise<CronRunResult> {
  const result: CronRunResult = {
    refilled: 0,
    succeeded: 0,
    failed: 0,
    actorFilesUpdated: 0,
    queuePending: 0,
    queueTotal: 0,
    nextPage: 1,
    errors: [],
  };

  try {
    if ((await getQueuePendingCount(env)) < REFILL_THRESHOLD) {
      result.refilled = await refillQueue(env);
    }
  } catch (err) {
    result.errors.push(`refill: ${(err as Error).message}`);
  }

  const item = await nextQueueItem(env);
  if (!item) {
    const s = await getQueueStats(env);
    result.queuePending = s.pending;
    result.queueTotal = s.total;
    result.nextPage = s.next_page;
    return result;
  }

  if (!(await markQueueInProgress(env, item.id))) return result;

  let scrape: ScrapeResult;
  try {
    scrape = await scrapeOne(env, item.slug, item.anilist_id, item.title);
  } catch (err) {
    scrape = {
      ok: false,
      fileCount: 0,
      error: (err as Error).message,
      voiceActors: [],
    };
  }

  if (scrape.ok) {
    await deleteQueueItem(env, item.id);
    result.succeeded = 1;

    if (scrape.voiceActors.length > 0) {
      const a = await mergeActorFiles(env, scrape.voiceActors);
      if (a.ok) result.actorFilesUpdated = a.files;
      else result.errors.push(`actors: ${a.error}`);
    }
  } else {
    await markQueueFailed(env, item.id, scrape.error ?? 'unknown');
    result.failed = 1;
    result.errors.push(`${item.slug}: ${scrape.error}`);
  }

  const s = await getQueueStats(env);
  result.queuePending = s.pending;
  result.queueTotal = s.total;
  result.nextPage = s.next_page;

  return result;
}
