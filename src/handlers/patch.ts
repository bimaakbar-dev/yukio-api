import type { Env, FileToCommit } from '../types';
import { githubGetFile, githubCommitMultipleFiles } from '../lib/github';
import { fetchRatingFromShikimori } from '../lib/sources';
import { getInstallationToken } from '../lib/github-app';
import { getMeta, setMeta } from '../lib/state';

const VALID = new Set(['G', 'PG', 'PG-13', 'R', 'R+', 'Rx']);
const CONCURRENCY = 5;
const DELAY_MS = 100;

interface TickResult {
  shard: number;
  totalShards: number;
  processed: number;
  updated: number;
  skippedHasRating: number;
  skippedNoMalId: number;
  failed: number;
  totalShardFiles: number;
  offsetFrom: number;
  offsetTo: number;
  done: boolean;
  errors: string[];
}

let cachedPaths: { paths: string[]; expiresAt: number } | null = null;

async function listAllAnimePaths(env: Env): Promise<string[]> {
  const now = Date.now();
  if (cachedPaths && cachedPaths.expiresAt > now) {
    return cachedPaths.paths;
  }

  const token = await getInstallationToken(env);
  const url = `https://api.github.com/repos/${env.YUKIO_DATA_REPO}/git/trees/${env.YUKIO_DATA_BRANCH}?recursive=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'yukio-api/2.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`tree HTTP ${res.status}`);

  const json = (await res.json()) as {
    tree: { path: string; type: string }[];
  };
  const paths = json.tree
    .filter(
      (t) =>
        t.type === 'blob' &&
        t.path.startsWith('src/content/anime/') &&
        t.path.endsWith('.md')
    )
    .map((t) => t.path)
    .sort();

  cachedPaths = { paths, expiresAt: now + 5 * 60 * 1000 };
  return paths;
}

function getShardPaths(
  allPaths: string[],
  shard: number,
  totalShards: number
): string[] {
  if (totalShards <= 1) return allPaths;
  return allPaths.filter((_, i) => i % totalShards === shard);
}

function splitFrontmatter(content: string): {
  fm: string[];
  rest: string[];
} | null {
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return { fm: lines.slice(1, end), rest: lines.slice(end) };
}

function parseMalId(fm: string[]): number | null {
  for (const line of fm) {
    const m = line.match(/^malId:\s*(\d+)\s*$/);
    if (m) return parseInt(m[1]!, 10);
  }
  return null;
}

function hasValidRating(fm: string[]): boolean {
  for (const line of fm) {
    const m = line.match(/^rating:\s*(.+?)\s*$/);
    if (m) {
      const v = m[1]!.replace(/["']/g, '').trim();
      if (VALID.has(v)) return true;
    }
  }
  return false;
}

function insertRating(fm: string[], rating: string): string[] {
  const cleaned = fm.filter((l) => !/^rating:/.test(l));
  const out: string[] = [];
  let inserted = false;
  for (const line of cleaned) {
    out.push(line);
    if (!inserted && /^status:/.test(line)) {
      out.push(`rating: ${rating}`);
      inserted = true;
    }
  }
  if (!inserted) out.push(`rating: ${rating}`);
  return out;
}

async function processOne(
  env: Env,
  path: string
): Promise<
  | { kind: 'update'; file: FileToCommit }
  | { kind: 'skip-has-rating' }
  | { kind: 'skip-no-mal' }
  | { kind: 'error'; message: string }
> {
  try {
    const existing = await githubGetFile(env, path);
    if (!existing) return { kind: 'error', message: 'file not found' };

    const parsed = splitFrontmatter(existing.content);
    if (!parsed) return { kind: 'error', message: 'no frontmatter' };

    if (hasValidRating(parsed.fm)) return { kind: 'skip-has-rating' };

    const malId = parseMalId(parsed.fm);
    if (!malId) return { kind: 'skip-no-mal' };

    const rating = await fetchRatingFromShikimori(malId);
    if (!rating) return { kind: 'skip-no-mal' };

    const newFm = insertRating(parsed.fm, rating);
    const newContent =
      '---\n' + newFm.join('\n') + '\n' + parsed.rest.join('\n');

    return { kind: 'update', file: { path, content: newContent } };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message ?? 'unknown' };
  }
}

export async function runRatingTick(
  env: Env,
  batchSize: number
): Promise<TickResult> {
  const shard = Math.max(0, parseInt(env.PATCH_SHARD ?? '0', 10) || 0);
  const totalShards = Math.max(
    1,
    parseInt(env.PATCH_TOTAL_SHARDS ?? '1', 10) || 1
  );

  const result: TickResult = {
    shard,
    totalShards,
    processed: 0,
    updated: 0,
    skippedHasRating: 0,
    skippedNoMalId: 0,
    failed: 0,
    totalShardFiles: 0,
    offsetFrom: 0,
    offsetTo: 0,
    done: false,
    errors: [],
  };

  const allPaths = await listAllAnimePaths(env);
  const shardPaths = getShardPaths(allPaths, shard, totalShards);
  result.totalShardFiles = shardPaths.length;

  const offsetKey = `patch_rating_offset_shard_${shard}`;
  const doneKey = `patch_rating_done_shard_${shard}`;

  const offsetStr = (await getMeta(env, offsetKey)) ?? '0';
  const offset = Math.max(0, parseInt(offsetStr, 10) || 0);
  result.offsetFrom = offset;

  if (offset >= shardPaths.length) {
    await setMeta(env, doneKey, '1');
    result.offsetTo = offset;
    result.done = true;
    return result;
  }

  const slice = shardPaths.slice(offset, offset + batchSize);
  if (slice.length === 0) {
    result.offsetTo = offset;
    result.done = true;
    await setMeta(env, doneKey, '1');
    return result;
  }

  const filesToCommit: FileToCommit[] = [];

  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    const batch = slice.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((p) => processOne(env, p)));

    for (const r of results) {
      result.processed++;
      if (r.kind === 'update') {
        filesToCommit.push(r.file);
        result.updated++;
      } else if (r.kind === 'skip-has-rating') {
        result.skippedHasRating++;
      } else if (r.kind === 'skip-no-mal') {
        result.skippedNoMalId++;
      } else {
        result.failed++;
        result.errors.push(r.message);
      }
    }

    if (i + CONCURRENCY < slice.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  if (filesToCommit.length > 0) {
    const commitMsg = `chore(data): backfill age rating [shard ${shard}] offset ${offset}`;
    const commitResult = await githubCommitMultipleFiles(
      env,
      filesToCommit,
      commitMsg
    );
    if (!commitResult.ok) {
      result.errors.push(`commit: ${commitResult.error}`);
    }
  }

  const nextOffset = offset + slice.length;
  await setMeta(env, offsetKey, String(nextOffset));
  result.offsetTo = nextOffset;
  result.done = nextOffset >= shardPaths.length;

  if (result.done) {
    await setMeta(env, doneKey, '1');
  }

  return result;
}

export async function resetRatingPatch(env: Env): Promise<void> {
  const shard = Math.max(0, parseInt(env.PATCH_SHARD ?? '0', 10) || 0);
  await setMeta(env, `patch_rating_offset_shard_${shard}`, '0');
  await setMeta(env, `patch_rating_done_shard_${shard}`, '0');
  cachedPaths = null;
}

export async function getRatingPatchStatus(env: Env): Promise<{
  shard: number;
  offset: number;
  done: boolean;
}> {
  const shard = Math.max(0, parseInt(env.PATCH_SHARD ?? '0', 10) || 0);
  const offsetStr =
    (await getMeta(env, `patch_rating_offset_shard_${shard}`)) ?? '0';
  const doneStr =
    (await getMeta(env, `patch_rating_done_shard_${shard}`)) ?? '0';
  return {
    shard,
    offset: parseInt(offsetStr, 10) || 0,
    done: doneStr === '1',
  };
}