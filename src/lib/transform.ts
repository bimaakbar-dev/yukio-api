import type {
  UnifiedCharacter,
  UnifiedEpisode,
  UnifiedRelation,
  UnifiedVoiceActor,
  FileToCommit,
} from '../types';

const CHAR_CHUNK_SIZE = 50;
const EP_CHUNK_SIZE = 12;
const MAX_ACTORS_PER_FILE = 500;

function yamlString(s: string): string {
  const cleaned = String(s ?? '').replace(/\n/g, ' ').trim();
  const needsQuote =
    /[:#&*!|>'"%@`{}\[\],]/.test(cleaned) ||
    cleaned === '' ||
    /^\d/.test(cleaned);
  if (!needsQuote) return cleaned;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function slugify(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatDate(
  year: number | null | undefined,
  month: number | null | undefined,
  day: number | null | undefined
): string | null {
  if (!year || !month || !day) return null;
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function guessSeason(month: number | null): string | null {
  if (!month) return null;
  if (month >= 1 && month <= 3) return 'winter';
  if (month >= 4 && month <= 6) return 'spring';
  if (month >= 7 && month <= 9) return 'summer';
  if (month >= 10 && month <= 12) return 'fall';
  return null;
}

const FORMAT_MAP: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
  UNKNOWN: 'Unknown',
};

const STATUS_MAP: Record<string, string> = {
  FINISHED: 'finished',
  RELEASING: 'airing',
  NOT_YET_RELEASED: 'upcoming',
  CANCELLED: 'cancelled',
  HIATUS: 'hiatus',
};

export interface MarkdownInput {
  media: import('../types').AniListMedia;
  malId: number | null;
  kitsuId: string | null;
  synopsis: string;
}

export function buildMarkdown(input: MarkdownInput): string {
  const { media, malId, kitsuId, synopsis } = input;
  const lines: string[] = [];

  lines.push('---');
  lines.push(`title: ${yamlString(media.title.romaji || 'Unknown')}`);
  if (media.title.english) {
    lines.push(`titleEnglish: ${yamlString(media.title.english)}`);
  }
  if (media.title.native) {
    lines.push(`titleNative: ${yamlString(media.title.native)}`);
  }
  lines.push('');

  const effectiveMalId = malId ?? media.myanimelistId ?? null;
  if (effectiveMalId) {
    lines.push(`malId: ${effectiveMalId}`);
  }
  if (kitsuId) {
    lines.push(`kitsuId: ${yamlString(kitsuId)}`);
  }
  lines.push('');

  lines.push(`type: ${FORMAT_MAP[media.format] ?? 'Unknown'}`);
  lines.push(`status: ${STATUS_MAP[media.status] ?? 'finished'}`);

  if (media.source) {
    lines.push(`source: ${media.source}`);
  }
  lines.push('');

  const season = guessSeason(media.startDate.month);
  if (season) lines.push(`season: ${season}`);
  if (media.seasonYear) lines.push(`year: ${media.seasonYear}`);
  if (media.episodes) lines.push(`episodes: ${media.episodes}`);

  if (media.duration && media.duration > 0) {
    lines.push(`duration: ${media.duration}`);
  }

  if (media.rating) {
    lines.push(`rating: ${media.rating}`);
  }
  lines.push('');

  const airedFrom = formatDate(
    media.startDate.year,
    media.startDate.month,
    media.startDate.day
  );
  const airedTo = formatDate(
    media.endDate?.year ?? null,
    media.endDate?.month ?? null,
    media.endDate?.day ?? null
  );

  if (airedFrom || airedTo) {
    lines.push('aired:');
    if (airedFrom) {
      lines.push(`  from: "${airedFrom}"`);
    }
    if (airedTo) {
      lines.push(`  to: "${airedTo}"`);
    }
    lines.push('');
  }

  if (media.averageScore && media.averageScore > 0) {
    lines.push('stats:');
    lines.push(`  score: ${(media.averageScore / 10).toFixed(1)}`);
    lines.push('');
  }

  const genres = (media.genres ?? []).map(slugify).filter(Boolean);
  if (genres.length > 0) {
    lines.push('genres:');
    for (const g of genres) lines.push(`  - ${g}`);
  } else {
    lines.push('genres: []');
  }
  lines.push('');

  const studios = (media.studios?.nodes ?? [])
    .map((s) => slugify(s.name))
    .filter(Boolean);
  if (studios.length > 0) {
    lines.push('studios:');
    for (const s of studios) lines.push(`  - ${s}`);
  } else {
    lines.push('studios: []');
  }
  lines.push('');

  if (media.coverImage.extraLarge) {
    lines.push(`image: "${media.coverImage.extraLarge}"`);
  }

  if (media.banner) {
    lines.push(`banner: "${media.banner}"`);
  }

  if (media.trailer) {
    lines.push(`trailer: "${media.trailer}"`);
  }
  lines.push('');

  lines.push('draft: false');
  lines.push('---');
  lines.push('');

  const body = synopsis.trim() || '> ⚠️ Sinopsis belum tersedia.';
  lines.push(body);

  return lines.join('\n');
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function buildCharacterFiles(
  slug: string,
  characters: UnifiedCharacter[]
): FileToCommit[] {
  if (characters.length === 0) return [];

  const sorted = [...characters].sort((a, b) => {
    if (a.role === 'main' && b.role !== 'main') return -1;
    if (a.role !== 'main' && b.role === 'main') return 1;
    return a.name.localeCompare(b.name);
  });

  const chunks = chunkArray(sorted, CHAR_CHUNK_SIZE);
  const files: FileToCommit[] = [];

  let cursor = 1;
  for (const chunk of chunks) {
    const start = cursor;
    const end = cursor + chunk.length - 1;
    files.push({
      path: `data/anime/${slug}/characters/${start}-${end}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
    });
    cursor = end + 1;
  }

  return files;
}

export function buildEpisodeFiles(
  slug: string,
  episodes: UnifiedEpisode[]
): FileToCommit[] {
  if (episodes.length === 0) return [];

  const sorted = [...episodes].sort((a, b) => a.number - b.number);
  const chunks = chunkArray(sorted, EP_CHUNK_SIZE);
  const files: FileToCommit[] = [];

  for (const chunk of chunks) {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (!first || !last) continue;

    files.push({
      path: `data/anime/${slug}/episodes/${first.number}-${last.number}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
    });
  }

  return files;
}

export function buildFranchiseFile(
  slug: string,
  relations: UnifiedRelation[]
): FileToCommit | null {
  if (relations.length === 0) return null;

  return {
    path: `data/anime/${slug}/franchises.json`,
    content: JSON.stringify(relations, null, 2) + '\n',
  };
}

export function buildActorFiles(
  voiceActors: UnifiedVoiceActor[]
): FileToCommit[] {
  if (voiceActors.length === 0) return [];

  const groups = new Map<string, UnifiedVoiceActor[]>();

  for (const va of voiceActors) {
    const first = (va.id.charAt(0) || '').toLowerCase();
    const letter = /^[a-z]$/.test(first) ? first : '_';
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter)!.push(va);
  }

  const files: FileToCommit[] = [];

  for (const [letter, items] of groups) {
    items.sort((a, b) => a.id.localeCompare(b.id));

    const chunks = chunkArray(items, MAX_ACTORS_PER_FILE);
    if (chunks.length === 1) {
      files.push({
        path: `data/actors/${letter}.json`,
        content: JSON.stringify(items, null, 2) + '\n',
      });
    } else {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        files.push({
          path: `data/actors/${letter}-${i + 1}.json`,
          content: JSON.stringify(chunk, null, 2) + '\n',
        });
      }
    }
  }

  return files;
}

export interface BuildAllInput {
  slug: string;
  media: import('../types').AniListMedia;
  malId: number | null;
  kitsuId: string | null;
  synopsis: string;
  characters: UnifiedCharacter[];
  episodes: UnifiedEpisode[];
  relations: UnifiedRelation[];
  voiceActors: UnifiedVoiceActor[];
}

export interface BuildAllResult {
  markdown: string;
  animeFiles: FileToCommit[];
  actorFiles: FileToCommit[];
}

export function buildAll(input: BuildAllInput): BuildAllResult {
  const {
    slug,
    media,
    malId,
    kitsuId,
    synopsis,
    characters,
    episodes,
    relations,
    voiceActors,
  } = input;

  const markdown = buildMarkdown({ media, malId, kitsuId, synopsis });

  const animeFiles: FileToCommit[] = [];

  const franchiseFile = buildFranchiseFile(slug, relations);
  if (franchiseFile) animeFiles.push(franchiseFile);

  animeFiles.push(...buildCharacterFiles(slug, characters));
  animeFiles.push(...buildEpisodeFiles(slug, episodes));

  const actorFiles = buildActorFiles(voiceActors);

  return { markdown, animeFiles, actorFiles };
}