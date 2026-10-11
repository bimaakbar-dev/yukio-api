import type {
  AniListMedia,
  AniListTopItem,
  UnifiedVoiceActor,
  UnifiedCharacter,
  UnifiedEpisode,
  UnifiedRelation,
} from '../types';

const ANILIST_PROXY = 'https://yukio-db.val.run/';
const SHIKIMORI_BASE = 'https://shikimori.one/api/animes';
const KITSU_BASE = 'https://kitsu.io/api/edge/anime';

const TIMEOUT_MS = 12000;
const PAGE_SIZE = 50;
const KITSU_PAGE_LIMIT = 20;
const PARALLEL_BATCH = 5;

async function fetchTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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

export { slugify };

async function gql<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T | null> {
  try {
    const res = await fetchTimeout(ANILIST_PROXY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'yukio-api/2.0',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string }[];
    };

    if (json.errors?.length) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

const SORT_MAP: Record<string, string> = {
  popular: 'POPULARITY_DESC',
  rating: 'SCORE_DESC',
  trending: 'TRENDING_DESC',
  id: 'ID',
};

export async function fetchAniListTop(
  page: number,
  sortKey: string
): Promise<AniListTopItem[]> {
  const sort = SORT_MAP[sortKey] ?? 'POPULARITY_DESC';

  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: ${PAGE_SIZE}) {
        media(type: ANIME, sort: [${sort}], isAdult: false) {
          id
          idMal
          title { romaji english native }
          format
        }
      }
    }
  `;

  const data = await gql<{
    Page?: { media?: AniListTopItem[] };
  }>(query, { page });

  return data?.Page?.media ?? [];
}

interface AniListMediaRaw {
  id: number;
  idMal: number | null;
  title: { romaji?: string; english?: string; native?: string };
  coverImage: { extraLarge?: string; large?: string };
  bannerImage: string | null;
  description: string | null;
  genres: string[];
  studios: { nodes: { name: string }[] };
  episodes: number | null;
  duration: number | null;
  status: string;
  format: string;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  endDate: { year: number | null; month: number | null; day: number | null };
  averageScore: number | null;
  trailer: { id: string; site: string } | null;
  source: string | null;
}

function mapAniListFormat(raw: string | null | undefined): string {
  if (!raw) return 'TV';
  const upper = raw.toUpperCase();
  const map: Record<string, string> = {
    TV: 'TV',
    TV_SHORT: 'TV',
    MOVIE: 'MOVIE',
    SPECIAL: 'SPECIAL',
    OVA: 'OVA',
    ONA: 'ONA',
    MUSIC: 'MUSIC',
  };
  return map[upper] ?? 'TV';
}

function mapAniListStatus(raw: string | null | undefined): string {
  if (!raw) return 'RELEASING';
  const upper = raw.toUpperCase();
  const map: Record<string, string> = {
    FINISHED: 'FINISHED',
    RELEASING: 'RELEASING',
    NOT_YET_RELEASED: 'NOT_YET_RELEASED',
    CANCELLED: 'CANCELLED',
    HIATUS: 'HIATUS',
  };
  return map[upper] ?? 'RELEASING';
}

function mapAniListSource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const map: Record<string, string> = {
    original: 'original',
    manga: 'manga',
    light_novel: 'light_novel',
    visual_novel: 'visual_novel',
    video_game: 'game',
    game: 'game',
    novel: 'novel',
    doujinshi: 'manga',
    anime: 'original',
    web_novel: 'web_novel',
    live_action: 'other',
    comic: 'manga',
    multimedia_project: 'other',
    picture_book: 'picture_book',
    radio: 'radio',
    music: 'music',
    card_game: 'card_game',
    '4_koma_manga': '4_koma_manga',
    book: 'book',
    other: 'other',
  };
  return map[lower] ?? null;
}

export async function fetchAniListById(
  id: number
): Promise<AniListMedia | null> {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        title { romaji english native }
        coverImage { extraLarge large }
        bannerImage
        description
        genres
        studios(isMain: true) { nodes { name } }
        episodes
        duration
        status
        format
        season
        seasonYear
        startDate { year month day }
        endDate { year month day }
        averageScore
        trailer { id site }
        source
      }
    }
  `;

  const data = await gql<{ Media?: AniListMediaRaw }>(query, { id });
  const m = data?.Media;
  if (!m) return null;

  let trailer: string | null = null;
  if (m.trailer?.site === 'youtube' && m.trailer.id) {
    trailer = m.trailer.id;
  }

  const studios = (m.studios?.nodes ?? [])
    .map((s) => ({ name: s.name }))
    .slice(0, 3);

  return {
    id: m.id,
    title: {
      romaji: m.title.romaji ?? 'Unknown',
      english: m.title.english ?? null,
      native: m.title.native ?? null,
    },
    coverImage: {
      extraLarge: m.coverImage.extraLarge ?? '',
      large: m.coverImage.large ?? '',
    },
    description: m.description ?? null,
    format: mapAniListFormat(m.format),
    status: mapAniListStatus(m.status),
    seasonYear: m.seasonYear ?? null,
    episodes: m.episodes ?? null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    averageScore: m.averageScore ?? null,
    studios: { nodes: studios },
    startDate: {
      year: m.startDate?.year ?? null,
      month: m.startDate?.month ?? null,
      day: m.startDate?.day ?? null,
    },
    duration: m.duration ?? null,
    rating: null,
    endDate: m.endDate?.year
      ? {
          year: m.endDate.year,
          month: m.endDate.month ?? null,
          day: m.endDate.day ?? null,
        }
      : null,
    banner: m.bannerImage ?? null,
    trailer,
    myanimelistId: m.idMal ?? null,
    source: mapAniListSource(m.source),
  };
}

interface AniListCharEdge {
  role: string;
  node: {
    id: number;
    name: { full?: string; native?: string };
    image?: { large?: string };
  };
  voiceActors: {
    id: number;
    name: { full?: string; native?: string };
    languageV2?: string;
    image?: { large?: string };
  }[];
}

async function fetchCharsPage(
  idMal: number,
  page: number
): Promise<{ edges: AniListCharEdge[]; lastPage: number } | null> {
  const query = `
    query ($idMal: Int, $page: Int) {
      Media(idMal: $idMal, type: ANIME) {
        characters(page: $page, perPage: 25, sort: [ROLE, RELEVANCE]) {
          pageInfo { hasNextPage currentPage lastPage total }
          edges {
            role
            node {
              id
              name { full native }
              image { large }
            }
            voiceActors(language: JAPANESE) {
              id
              name { full native }
              languageV2
              image { large }
            }
          }
        }
      }
    }
  `;

  const data = await gql<{
    Media?: {
      characters?: {
        pageInfo: { lastPage: number };
        edges: AniListCharEdge[];
      };
    };
  }>(query, { idMal, page });

  const chars = data?.Media?.characters;
  if (!chars) return null;

  return {
    edges: chars.edges ?? [],
    lastPage: chars.pageInfo?.lastPage ?? 1,
  };
}

export async function fetchCharactersFromAniList(
  idMal: number,
  maxChars: number
): Promise<{
  characters: UnifiedCharacter[];
  voiceActors: UnifiedVoiceActor[];
} | null> {
  const first = await fetchCharsPage(idMal, 1);
  if (!first) return null;

  const maxPages = Math.ceil(maxChars / 25) + 1;
  const lastPage = Math.min(first.lastPage, maxPages);
  const allEdges: AniListCharEdge[] = [...first.edges];

  if (lastPage > 1) {
    for (let start = 2; start <= lastPage; start += PARALLEL_BATCH) {
      const pages: number[] = [];
      for (let i = 0; i < PARALLEL_BATCH && start + i <= lastPage; i++) {
        pages.push(start + i);
      }

      const results = await Promise.allSettled(
        pages.map((p) => fetchCharsPage(idMal, p))
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          allEdges.push(...r.value.edges);
        }
      }
    }
  }

  const characters: UnifiedCharacter[] = [];
  const vaMap = new Map<string, UnifiedVoiceActor>();
  const seenChars = new Set<string>();

  for (const edge of allEdges) {
    const roleRaw = (edge.role ?? '').toUpperCase();
    if (roleRaw !== 'MAIN' && roleRaw !== 'SUPPORTING') continue;

    const name = edge.node.name?.full?.trim();
    if (!name || seenChars.has(name)) continue;
    seenChars.add(name);

    const vaSlugs: string[] = [];

    for (const va of edge.voiceActors ?? []) {
      const vaName = va.name?.full?.trim();
      if (!vaName) continue;

      const vaSlug = slugify(vaName);
      if (!vaSlug) continue;

      if (!vaMap.has(vaSlug)) {
        vaMap.set(vaSlug, {
          id: vaSlug,
          name: vaName,
          nameNative: va.name?.native?.trim() || undefined,
          image: va.image?.large || undefined,
          defaultLanguage: va.languageV2 || 'Japanese',
        });
      }

      if (!vaSlugs.includes(vaSlug)) vaSlugs.push(vaSlug);
    }

    characters.push({
      name,
      nameNative: edge.node.name?.native?.trim() || undefined,
      image: edge.node.image?.large || undefined,
      role: roleRaw.toLowerCase() as 'main' | 'supporting',
      voiceActors: vaSlugs,
    });

    if (characters.length >= maxChars) break;
  }

  const voiceActors = [...vaMap.values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  return { characters, voiceActors };
}

interface ShikimoriRelated {
  relation?: string;
  anime?: { id: number; name: string } | null;
}

function mapShikimoriRelation(raw: string | undefined): string {
  if (!raw) return 'other';
  const lower = raw.toLowerCase();
  if (lower.includes('sequel')) return 'sequel';
  if (lower.includes('prequel')) return 'prequel';
  if (lower.includes('parent')) return 'parent_story';
  if (lower.includes('side story')) return 'side_story';
  if (lower.includes('spin')) return 'spin_off';
  if (lower.includes('alternative')) return 'alternative';
  if (lower.includes('adaptation')) return 'adaptation';
  if (lower.includes('summary')) return 'summary';
  if (lower.includes('full story')) return 'full_story';
  if (lower.includes('character')) return 'character';
  if (lower.includes('compilation')) return 'compilation';
  if (lower.includes('contains')) return 'contains';
  return 'other';
}

export async function fetchRelationsFromShikimori(
  malId: number
): Promise<UnifiedRelation[] | null> {
  try {
    const res = await fetchTimeout(`${SHIKIMORI_BASE}/${malId}/related`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-api/2.0',
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as ShikimoriRelated[];
    if (!Array.isArray(data) || data.length === 0) return null;

    const out: UnifiedRelation[] = [];
    const seen = new Set<string>();

    for (const entry of data) {
      if (!entry.anime) continue;
      const name = entry.anime.name;
      if (!name) continue;

      const slug = slugify(name);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      out.push({
        relation: mapShikimoriRelation(entry.relation),
        slug,
        title: name,
      });
    }

    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

interface ShikimoriAnime {
  id: number;
  rating?: string | null;
}

export async function fetchRatingFromShikimori(
  malId: number
): Promise<string | null> {
  try {
    const res = await fetchTimeout(`${SHIKIMORI_BASE}/${malId}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-api/2.0',
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as ShikimoriAnime;
    const raw = (data.rating ?? '').toLowerCase().trim();
    const map: Record<string, string> = {
      g: 'G',
      pg: 'PG',
      pg_13: 'PG-13',
      r: 'R',
      r_plus: 'R+',
      rx: 'Rx',
    };
    return map[raw] ?? null;
  } catch {
    return null;
  }
}

interface KitsuAnimeRaw {
  id: string;
}

interface KitsuEpisodeItem {
  id: string;
  attributes?: {
    number?: number;
    canonicalTitle?: string;
    titles?: { en?: string; en_jp?: string; ja_jp?: string };
    airdate?: string | null;
    length?: number | null;
  };
}

export async function searchKitsuId(title: string): Promise<string | null> {
  try {
    const params = new URLSearchParams();
    params.set('filter[text]', title);
    params.set('page[limit]', '1');

    const res = await fetchTimeout(`${KITSU_BASE}?${params.toString()}`, {
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'User-Agent': 'yukio-api/2.0',
      },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as { data?: KitsuAnimeRaw[] };
    return json.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchEpisodesPage(
  kitsuId: string,
  offset: number
): Promise<KitsuEpisodeItem[] | null> {
  try {
    const params = new URLSearchParams();
    params.set('page[limit]', String(KITSU_PAGE_LIMIT));
    params.set('page[offset]', String(offset));
    params.set('sort', 'number');

    const res = await fetchTimeout(
      `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?${params.toString()}`,
      {
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'User-Agent': 'yukio-api/2.0',
        },
      }
    );

    if (!res.ok) return null;

    const json = (await res.json()) as { data?: KitsuEpisodeItem[] };
    return json.data ?? [];
  } catch {
    return null;
  }
}

export async function fetchEpisodesFromKitsu(
  kitsuId: string,
  maxEpisodes: number
): Promise<UnifiedEpisode[] | null> {
  const allEpisodes: KitsuEpisodeItem[] = [];
  const maxPages = Math.ceil(maxEpisodes / KITSU_PAGE_LIMIT);

  for (
    let batchStart = 0;
    batchStart < maxPages;
    batchStart += PARALLEL_BATCH
  ) {
    const offsets: number[] = [];
    for (let i = 0; i < PARALLEL_BATCH; i++) {
      const pageIdx = batchStart + i;
      if (pageIdx >= maxPages) break;
      offsets.push(pageIdx * KITSU_PAGE_LIMIT);
    }
    if (offsets.length === 0) break;

    const results = await Promise.allSettled(
      offsets.map((off) => fetchEpisodesPage(kitsuId, off))
    );

    let batchHadEnd = false;

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (r.value.length === 0) {
        batchHadEnd = true;
        continue;
      }
      allEpisodes.push(...r.value);
      if (r.value.length < KITSU_PAGE_LIMIT) batchHadEnd = true;
    }

    if (batchHadEnd) break;
    if (allEpisodes.length >= maxEpisodes) break;
  }

  if (allEpisodes.length === 0) return null;

  const out: UnifiedEpisode[] = [];
  const seen = new Set<number>();

  for (const ep of allEpisodes) {
    const attr = ep.attributes ?? {};
    const number = attr.number ?? out.length + 1;
    if (seen.has(number)) continue;
    seen.add(number);

    const title =
      attr.titles?.en ??
      attr.titles?.en_jp ??
      attr.canonicalTitle ??
      `Episode ${number}`;

    const aired = attr.airdate ? attr.airdate.split('T')[0] : undefined;
    const duration =
      attr.length && attr.length > 0 ? attr.length : undefined;

    out.push({
      number,
      title,
      ...(aired ? { aired } : {}),
      ...(duration ? { duration } : {}),
    });

    if (out.length >= maxEpisodes) break;
  }

  out.sort((a, b) => a.number - b.number);
  return out;
}