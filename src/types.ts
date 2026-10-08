export interface Env {
  DB: D1Database;
  GH_TOKEN: string;

  YUKIO_DATA_REPO: string;
  YUKIO_DATA_BRANCH: string;

  INCREMENTAL: string;
  ANILIST_SORT: string;
  MAX_EPISODES: string;
  MAX_CHARACTERS: string;
}

export interface ScrapeQueueRow {
  id: number;
  anilist_id: number;
  slug: string;
  title: string;
  status: 'pending' | 'in_progress' | 'failed';
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScrapeMetaRow {
  key: string;
  value: string;
  updated_at: number;
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

export interface AniListTopItem {
  id: number;
  idMal: number | null;
  title: AniListTitle;
  format: string;
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