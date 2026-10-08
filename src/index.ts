import type { Env, RequestContext } from './types.js';
import {
  getRatingData,
  getAllRatings,
  upsertRating,
  deleteRating,
} from './db.js';

const API_VERSION = 'v1';
const SCORE_MIN = 1;
const SCORE_MAX = 5;
const USER_ID_HEADER = 'X-User-Id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
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
  const body = { error: { code, message, status } };

  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-API-Version': API_VERSION,
      ...extraHeaders,
    },
  });
}

function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',')
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
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  if (isAllowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function resolveUser(request: Request): RequestContext {
  const headerValue = request.headers.get(USER_ID_HEADER);
  const origin = request.headers.get('Origin');

  if (headerValue && UUID_RE.test(headerValue)) {
    return { userId: headerValue, origin };
  }

  return { userId: '', origin };
}

function isValidAnimeId(id: string): boolean {
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
  return jsonResponse(data, { headers: corsHeaders });
}

async function handlePost(
  animeId: string,
  request: Request,
  env: Env,
  ctx: RequestContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!ctx.userId) {
    return errorResponse(
      'MISSING_USER_ID',
      `Header ${USER_ID_HEADER} wajib ada dan berisi UUID v4 yang valid`,
      400,
      corsHeaders
    );
  }

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
  return jsonResponse(data, { headers: corsHeaders });
}

async function handleDelete(
  animeId: string,
  env: Env,
  ctx: RequestContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!ctx.userId) {
    return errorResponse('MISSING_USER_ID', `Header ${USER_ID_HEADER} wajib ada`, 400, corsHeaders);
  }

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
  return jsonResponse(data, { headers: corsHeaders });
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

const RATINGS_ONE = /^\/api\/v1\/ratings\/([^/]+)\/?$/;
const RATINGS_ALL = /^\/api\/v1\/ratings\/?$/;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = request.headers.get('Origin');

  const allowedOrigins = getAllowedOrigins(env);
  const corsHeaders = buildCorsHeaders(origin, allowedOrigins);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const ctx = resolveUser(request);

  const oneMatch = path.match(RATINGS_ONE);
  const allMatch = path.match(RATINGS_ALL);

  if (oneMatch) {
    const animeId = oneMatch[1]!;

    if (method === 'GET') return handleGetOne(animeId, env, ctx, corsHeaders);
    if (method === 'POST') return handlePost(animeId, request, env, ctx, corsHeaders);
    if (method === 'DELETE') return handleDelete(animeId, env, ctx, corsHeaders);

    return errorResponse('METHOD_NOT_ALLOWED', `Method ${method} tidak didukung`, 405, corsHeaders);
  }

  if (allMatch && method === 'GET') {
    return handleGetAll(env, corsHeaders);
  }

  return errorResponse('NOT_FOUND', `Endpoint tidak ditemukan: ${path}`, 404, corsHeaders);
}

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