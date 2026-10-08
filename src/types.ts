export interface Env {
  DB: D1Database;
  AI: Ai;

  GH_TOKEN: string;

  YUKIONIME_API: string;
  YUKIO_DATA_REPO: string;
  YUKIO_DATA_BRANCH: string;

  BATCH_SIZE: string;
  PER_ANIME_TIMEOUT_MS: string;
  INCREMENTAL: string;
  SCRAPE_TTL_DAYS: string;
}

export type ScrapeStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'skipped';

export interface ScrapeStateRow {
  slug: string;
  status: ScrapeStatus;
  source_used: string | null;
  file_count: number;
  files_json: string;
  attempt_count: number;
  last_error: string | null;
  first_scraped_at: number | null;
  last_scraped_at: number | null;
  last_success_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface YukionimeListItem {
  id: string;
  title: string;
  titleEnglish?: string | null;
  titleNative?: string | null;
  image?: string | null;
  type: string;
  status: string;
  season?: string | null;
  year?: number | null;
  episodes?: number | null;
  duration?: number | null;
  rating?: string | null;
  genres?: string[];
  studios?: string[];
  stats?: { score?: number; scoredBy?: number } | null;
}

export interface AniListTitle {
  romaji: string;
  english: string | null;
  native: string | null;
}

export interface AniListCover {
  extraLarge: string;
  large: string;
}

export interface AniListDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface AniListStudio {
  name: string;
}

export interface AniListMedia {
  id: number;
  title: AniListTitle;
  coverImage: AniListCover;
  description: string | null;
  format: string;
  status: string;
  seasonYear: number | null;
  episodes: number | null;
  genres: string[];
  averageScore: number | null;
  studios: { nodes: AniListStudio[] };
  startDate: AniListDate;

  duration?: number | null;
  rating?: string | null;
  endDate?: AniListDate | null;
  banner?: string | null;
  trailer?: string | null;
  franchise?: string | null;
  myanimelistId?: number | null;
  source?: string | null;
}

export interface UnifiedVoiceActor {
  id: string;
  name: string;
  nameNative?: string;
  image?: string;
  defaultLanguage?: string;
}

export interface UnifiedCharacter {
  name: string;
  nameNative?: string;
  image?: string;
  role: 'main' | 'supporting' | 'background';
  voiceActors: string[];
}

export interface UnifiedEpisode {
  number: number;
  title: string;
  aired?: string;
  duration?: number;
}

export interface UnifiedRelation {
  relation: string;
  slug: string;
  title: string;
}

export interface ChainContext {
  malId: number | null;
  kitsuId: string | null;
  title: string;
}

export interface ScrapePayload {
  slug: string;
  markdown: string;
  franchises: UnifiedRelation[];
  characters: UnifiedCharacter[];
  episodes: UnifiedEpisode[];
  voiceActors: UnifiedVoiceActor[];
  sourceUsed: string;
}

export interface FileToCommit {
  path: string;
  content: string;
}

export interface CommitResult {
  ok: boolean;
  sha?: string;
  commitUrl?: string;
  error?: string;
}