// ────────────────────────────────────────────────────────
// Worker yukio-api — Entry point
// ────────────────────────────────────────────────────────
//
// Endpoint:
//   GET    /api/v1/ratings/:id   — ambil rating 1 anime (+ user vote)
//   POST   /api/v1/ratings/:id   — submit rating (score 1-5)
//   DELETE /api/v1/ratings/:id   — hapus rating user
//   GET    /api/v1/ratings       — ambil semua rating (untuk sync/audit)
//   OPTIONS *                    — CORS preflight
//
// Auth:
//   User ID dari cookie `vid` (UUID v4). Generate otomatis
//   kalau belum ada, set sebagai HttpOnly cookie.
//   Tidak ada login — anonymous tracking.
//
// CORS:
//   Whitelist dari env.ALLOWED_ORIGINS (comma-separated).
//   Tidak pakai wildcard — biar tidak di-embed orang lain.
//
// Response format:
//   Sukses: { data: ..., meta: { version, generatedAt } }
//   Error:  { error: { code, message, status } }
// ────────────────────────────────────────────────────────

import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Env, RequestContext } from './types.js';
import {
  getRatingData,
  getAllRatings,
  upsertRating,
  deleteRating,
} from './db.js';

// ────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────

const API_VERSION = 'v1';
const COOKIE_NAME = 'vid'; // visitor id
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2; // 2 tahun
const SCORE_MIN = 1;
const SCORE_MAX = 5;

// ────────────────────────────────────────────────────────
// Helpers — Response
// ────────────────────────────────────────────────────────

function jsonResponse(
  data: unknown,
  init: ResponseInit = {}
): Response {
  const body = {
    data,
    meta: {
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-API-Version': API_VERSION,
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status = 400,
  extraHeaders: HeadersInit = {}
): Response {
  const body = {
    error: { code, message, status },
  };

  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-API-Version': API_VERSION,
      ...extraHeaders,
    },
  });
}

// ────────────────────────────────────────────────────────
// Helpers — CORS
// ────────────────────────────────────────────────────────

function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function buildCorsHeaders(
  origin: string | null,
  allowedOrigins: string[]
): Record<string, string> {
  const isAllowed = origin != null && allowedOrigins.includes(origin);

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  if (isAllowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

// ────────────────────────────────────────────────────────
// Helpers — Auth (cookie)
// ────────────────────────────────────────────────────────

function generateUserId(): string {
  return crypto.randomUUID();
}

function parseAuthCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = parseCookie(cookieHeader);
  return cookies[COOKIE_NAME] ?? null;
}

function buildUserIdCookie(userId: string): string {
  return serializeCookie(COOKIE_NAME, userId, {
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: true,
    sameSite: 'none',
  });
}

/**
 * Resolve user ID dari cookie. Kalau tidak ada, generate baru.
 * Return juga flag isNewUser supaya handler tahu harus set cookie.
 */
function resolveUser(request: Request): RequestContext {
  const existing = parseAuthCookie(request);
  const origin = request.headers.get('Origin');

  if (existing) {
    return { userId: existing, isNewUser: false, origin };
  }

  return { userId: generateUserId(), isNewUser: true, origin };
}

/**
 * Append Set-Cookie header ke response kalau user baru.
 * Immutable: return Response baru (Response di Workers immutable).
 */
function withUserCookie(response: Response, ctx: RequestContext): Response {
  if (!ctx.isNewUser) return response;

  const newHeaders = new Headers(response.headers);
  newHeaders.append('Set-Cookie', buildUserIdCookie(ctx.userId));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ────────────────────────────────────────────────────────
// Helpers — Validation
// ────────────────────────────────────────────────────────

function isValidAnimeId(id: string): boolean {
  // Slug: lowercase-kebab-case, 1-200 char
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 200;
}

function isValidScore(score: unknown): score is number {
  return (
    typeof score === 'number' &&
    Number.isInteger(score) &&
    score >= SCORE_MIN &&
    score <= SCORE_MAX
  );
}

// ────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────

async function handleGetOne(
  animeId: string,
  env: Env,
  ctx: RequestContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!isValidAnimeId(animeId)) {
    return errorResponse('INVALID_ID', 'Format anime id tidak valid', 400, corsHeaders);
  }

  const data = await getRatingData(env.DB, animeId, ctx.userId);

  return withUserCookie(
    jsonResponse(data, { headers: corsHeaders }),
    ctx
  );
}

async function handlePost(
  animeId: string,
  request: Request,
  env: Env,
  ctx: RequestContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!isValidAnimeId(animeId)) {
    return errorResponse('INVALID_ID', 'Format anime id tidak valid', 400, corsHeaders);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 'Body harus JSON valid', 400, corsHeaders);
  }

  const score = (body as { score?: unknown })?.score;

  if (!isValidScore(score)) {
    return errorResponse(
      'INVALID_SCORE',
      `Score harus integer antara ${SCORE_MIN} dan ${SCORE_MAX}`,
      400,
      corsHeaders
    );
  }

  try {
    await upsertRating(env.DB, animeId, ctx.userId, score);
  } catch (err) {
    console.error('[yukio-api] upsert failed:', err);
    return errorResponse('DB_ERROR', 'Gagal menyimpan rating', 500, corsHeaders);
  }

  const data = await getRatingData(env.DB, animeId, ctx.userId);

  return withUserCookie(
    jsonResponse(data, { headers: corsHeaders }),
    ctx
  );
}

async function handleDelete(
  animeId: string,
  env: Env,
  ctx: RequestContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!isValidAnimeId(animeId)) {
    return errorResponse('INVALID_ID', 'Format anime id tidak valid', 400, corsHeaders);
  }

  try {
    await deleteRating(env.DB, animeId, ctx.userId);
  } catch (err) {
    console.error('[yukio-api] delete failed:', err);
    return errorResponse('DB_ERROR', 'Gagal menghapus rating', 500, corsHeaders);
  }

  const data = await getRatingData(env.DB, animeId, ctx.userId);

  return withUserCookie(
    jsonResponse(data, { headers: corsHeaders }),
    ctx
  );
}

async function handleGetAll(
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const rows = await getAllRatings(env.DB);

  const data = Object.fromEntries(
    rows.map((r) => [
      r.anime_id,
      {
        average: Math.round(r.avg_score * 2 * 10) / 10,
        votes: r.vote_count,
      },
    ])
  );

  return jsonResponse(data, { headers: corsHeaders });
}

// ────────────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────────────

const RATINGS_ONE = /^\/api\/v1\/ratings\/([^/]+)\/?$/;
const RATINGS_ALL = /^\/api\/v1\/ratings\/?$/;

async function route(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = request.headers.get('Origin');

  const allowedOrigins = getAllowedOrigins(env);
  const corsHeaders = buildCorsHeaders(origin, allowedOrigins);

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Resolve user context (cookie) — dipakai di semua GET/POST/DELETE
  const ctx = resolveUser(request);

  const oneMatch = path.match(RATINGS_ONE);
  const allMatch = path.match(RATINGS_ALL);

  if (oneMatch) {
    const animeId = oneMatch[1]!;

    if (method === 'GET') {
      return handleGetOne(animeId, env, ctx, corsHeaders);
    }
    if (method === 'POST') {
      return handlePost(animeId, request, env, ctx, corsHeaders);
    }
    if (method === 'DELETE') {
      return handleDelete(animeId, env, ctx, corsHeaders);
    }

    return errorResponse('METHOD_NOT_ALLOWED', `Method ${method} tidak didukung`, 405, corsHeaders);
  }

  if (allMatch && method === 'GET') {
    return handleGetAll(env, corsHeaders);
  }

  return errorResponse('NOT_FOUND', `Endpoint tidak ditemukan: ${path}`, 404, corsHeaders);
}

// ────────────────────────────────────────────────────────
// Entry
// ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('[yukio-api] unhandled error:', err);
      return errorResponse('INTERNAL_ERROR', 'Terjadi kesalahan server', 500);
    }
  },
} satisfies ExportedHandler<Env>;