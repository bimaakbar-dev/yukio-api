import type {
  Env,
  UnifiedVoiceActor,
  FileToCommit,
} from '../types';
import {
  chainSearch,
  fetchCharactersFromAniList,
  fetchRelationsFromShikimori,
  fetchEpisodesFromKitsu,
} from '../lib/sources';
import { buildAll } from '../lib/transform';
import { generateSynopsis } from '../lib/ai';
import {
  githubCommitMultipleFiles,
  githubGetFile,
} from '../lib/github';
import {
  fetchYukionimeList,
  seedAnimeList,
  getNextBatch,
  markInProgress,
  markSuccess,
  markFailed,
  getStats,
  writeLog,
} from '../lib/state';

const DEFAULT_BATCH = 8;
const DEFAULT_TIMEOUT_MS = 20000;

interface ScrapeOneResult {
  ok: boolean;
  fileCount: number;
  files: string[];
  sourceUsed: string;
  error?: string;
  voiceActors: UnifiedVoiceActor[];
}

async function scrapeOne(
  env: Env,
  slug: string
): Promise<ScrapeOneResult> {
  const t0 = Date.now();
  const log = (msg: string) =>
    console.log(`[Scrape:${slug}] ${msg} (+${Date.now() - t0}ms)`);

  log('start');

  const chain = await chainSearch(slug);
  log(`chain search: ${chain.source}`);

  const { media, malId, kitsuId } = chain;

  const [charsResult, relationsResult, episodesResult] = await Promise.all([
    malId
      ? fetchCharactersFromAniList(malId).catch(() => null)
      : Promise.resolve(null),
    malId
      ? fetchRelationsFromShikimori(malId).catch(() => null)
      : Promise.resolve(null),
    kitsuId
      ? fetchEpisodesFromKitsu(kitsuId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const characters = charsResult?.characters ?? [];
  const voiceActors = charsResult?.voiceActors ?? [];
  const relations = relationsResult ?? [];
  const episodes = episodesResult ?? [];

  log(
    `fetched: chars=${characters.length}, VA=${voiceActors.length}, rel=${relations.length}, eps=${episodes.length}`
  );

  const studio = media.studios?.nodes?.[0]?.name ?? null;

  const synopsis =
    (await generateSynopsis(env, {
      title: media.title.romaji || slug,
      titleEnglish: media.title.english,
      originalSynopsis: media.description,
      year: media.seasonYear,
      genres: media.genres,
      studio,
    })) ?? '';

  log(`synopsis: ${synopsis.length} chars`);

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

  const allAnimeFiles: FileToCommit[] = [
    { path: markdownPath, content: built.markdown },
    ...built.animeFiles,
  ];

  const commitMsg = `feat(${slug}): scrape data from ${chain.source}`;

  const commitResult = await githubCommitMultipleFiles(
    env,
    allAnimeFiles,
    commitMsg
  );

  if (!commitResult.ok) {
    log(`commit FAILED: ${commitResult.error}`);
    return {
      ok: false,
      fileCount: 0,
      files: [],
      sourceUsed: chain.source,
      error: commitResult.error ?? 'commit failed',
      voiceActors,
    };
  }

  log(`commit OK: ${commitResult.sha?.slice(0, 7)} (${allAnimeFiles.length} files)`);

  return {
    ok: true,
    fileCount: allAnimeFiles.length,
    files: allAnimeFiles.map((f) => f.path),
    sourceUsed: chain.source,
    voiceActors,
  };
}

/* ============================================================
   ACTOR FILES — merge global actor list
   ============================================================ */

async function mergeActorFiles(
  env: Env,
  incomingVoiceActors: UnifiedVoiceActor[]
): Promise<{ ok: boolean; files: number; error?: string }> {
  if (incomingVoiceActors.length === 0) {
    return { ok: true, files: 0 };
  }

  const grouped = new Map<string, UnifiedVoiceActor[]>();

  for (const va of incomingVoiceActors) {
    const first = (va.id.charAt(0) || '').toLowerCase();
    const letter = /^[a-z]$/.test(first) ? first : '_';
    if (!grouped.has(letter)) grouped.set(letter, []);
    grouped.get(letter)!.push(va);
  }

  const filesToCommit: FileToCommit[] = [];

  for (const [letter, incoming] of grouped) {
    const path = `data/actors/${letter}.json`;

    const existing = await githubGetFile(env, path);

    const map = new Map<string, UnifiedVoiceActor>();

    if (existing) {
      try {
        const parsed = JSON.parse(existing.content) as UnifiedVoiceActor[];
        if (Array.isArray(parsed)) {
          for (const va of parsed) {
            if (va?.id) map.set(va.id, va);
          }
        }
      } catch {
        // Corrupt existing — overwrite saja
      }
    }

    let newCount = 0;
    for (const va of incoming) {
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

    if (newCount === 0 && existing) {
      continue;
    }

    const sorted = [...map.values()].sort((a, b) =>
      a.id.localeCompare(b.id)
    );

    filesToCommit.push({
      path,
      content: JSON.stringify(sorted, null, 2) + '\n',
    });
  }

  if (filesToCommit.length === 0) {
    return { ok: true, files: 0 };
  }

  const result = await githubCommitMultipleFiles(
    env,
    filesToCommit,
    `chore(actors): update ${filesToCommit.length} file(s)`
  );

  if (!result.ok) {
    return { ok: false, files: 0, error: result.error };
  }

  return { ok: true, files: filesToCommit.length };
}

/* ============================================================
   MAIN RUNNER
   ============================================================ */

export interface CronRunResult {
  totalAvailable: number;
  batchProcessed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  actorFilesUpdated: number;
  errors: string[];
}

export async function runScrapeCron(env: Env): Promise<CronRunResult> {
  const t0 = Date.now();
  const log = (msg: string) =>
    console.log(`[Cron] ${msg} (+${Date.now() - t0}ms)`);

  const batchSize = parseInt(env.BATCH_SIZE ?? String(DEFAULT_BATCH), 10);
  const incremental = env.INCREMENTAL === 'true';
  const ttlDays = parseInt(env.SCRAPE_TTL_DAYS ?? '30', 10);

  log(`start — batch=${batchSize}, incremental=${incremental}, ttl=${ttlDays}d`);

  /* ── 1. Seed dari yukionime ─────────────────────── */
  let items: Awaited<ReturnType<typeof fetchYukionimeList>> = [];
  try {
    items = await fetchYukionimeList(env);
    log(`yukionime list: ${items.length} anime`);
  } catch (err) {
    log(`fetch yukionime FAILED: ${err}`);
    return {
      totalAvailable: 0,
      batchProcessed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      actorFilesUpdated: 0,
      errors: [`yukionime fetch: ${(err as Error).message}`],
    };
  }

  const inserted = await seedAnimeList(env, items);
  if (inserted > 0) log(`seeded ${inserted} new anime to scrape_state`);

  /* ── 2. Ambil batch ─────────────────────────────── */
  const slugs = await getNextBatch(env, batchSize, incremental, ttlDays);
  const stats = await getStats(env);

  log(`batch: ${slugs.length} slugs — total pending ${stats.pending}, failed ${stats.failed}, success ${stats.success}`);

  if (slugs.length === 0) {
    log('nothing to scrape, exit');

    await writeLog(env, {
      durationMs: Date.now() - t0,
      totalAvailable: stats.total,
      batchSize: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    });

    return {
      totalAvailable: stats.total,
      batchProcessed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      actorFilesUpdated: 0,
      errors: [],
    };
  }

  /* ── 3. Proses tiap anime ───────────────────────── */
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const allVoiceActors: UnifiedVoiceActor[] = [];

  for (const slug of slugs) {
    const locked = await markInProgress(env, slug);
    if (!locked) {
      log(`skip ${slug} — already in progress`);
      skipped++;
      continue;
    }

    try {
      const result = await Promise.race([
        scrapeOne(env, slug),
        new Promise<ScrapeOneResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                fileCount: 0,
                files: [],
                sourceUsed: 'timeout',
                error: `timeout after ${DEFAULT_TIMEOUT_MS}ms`,
                voiceActors: [],
              }),
            DEFAULT_TIMEOUT_MS * 4
          )
        ),
      ]);

      if (result.ok) {
        await markSuccess(env, {
          slug,
          sourceUsed: result.sourceUsed,
          files: result.files,
        });
        allVoiceActors.push(...result.voiceActors);
        succeeded++;
        log(`✓ ${slug} (${result.fileCount} files)`);
      } else {
        await markFailed(env, slug, result.error ?? 'unknown');
        errors.push(`${slug}: ${result.error ?? 'unknown'}`);
        failed++;
        log(`✗ ${slug} — ${result.error}`);
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      await markFailed(env, slug, msg);
      errors.push(`${slug}: ${msg}`);
      failed++;
      log(`✗ ${slug} — ${msg}`);
    }
  }

  /* ── 4. Merge actor files ───────────────────────── */
  let actorFilesUpdated = 0;

  if (allVoiceActors.length > 0) {
    log(`merging ${allVoiceActors.length} voice actors`);
    const actorResult = await mergeActorFiles(env, allVoiceActors);

    if (actorResult.ok) {
      actorFilesUpdated = actorResult.files;
      log(`actor files updated: ${actorFilesUpdated}`);
    } else {
      errors.push(`actors merge: ${actorResult.error}`);
      log(`actor merge FAILED: ${actorResult.error}`);
    }
  }

  /* ── 5. Log ─────────────────────────────────────── */
  const durationMs = Date.now() - t0;

  await writeLog(env, {
    durationMs,
    totalAvailable: stats.total,
    batchSize: slugs.length,
    succeeded,
    failed,
    skipped,
    errors,
  });

  log(
    `done — ${succeeded} success, ${failed} failed, ${skipped} skipped, ${actorFilesUpdated} actor files (${durationMs}ms)`
  );

  return {
    totalAvailable: stats.total,
    batchProcessed: slugs.length,
    succeeded,
    failed,
    skipped,
    actorFilesUpdated,
    errors,
  };
}

/* ============================================================
   MANUAL RUN — untuk endpoint /admin/scrape
   ============================================================ */


