export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
}

export interface RatingRow {
  anime_id: string;
  user_id: string;
  score: number;
  created_at: number;
  updated_at: number;
}

export interface RatingAggregate {
  anime_id: string;
  avg_score: number | null;
  vote_count: number;
}

export interface RatingData {
  animeId: string;
  average: number;
  votes: number;
  userScore: number | null;
}

export interface ApiSuccess<T> {
  data: T;
  meta: {
    version: string;
    generatedAt: string;
    [key: string]: unknown;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    status: number;
  };
}

export interface RequestContext {
  userId: string;
  origin: string | null;
}