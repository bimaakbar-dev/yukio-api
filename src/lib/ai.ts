import type { Env } from '../types';

const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/qwen/qwen3-30b-a3b-fp8',
];

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AIRunResponse {
  response?: string;
  result?: string;
}

const TIMEOUT_MS = 15000;

function looksIndonesian(s: string): boolean {
  const words = [
    ' yang ', ' dengan ', ' untuk ', ' adalah ', ' dan ',
    ' di ', ' ke ', ' dari ', ' ini ', ' itu ',
    ' tidak ', ' akan ', ' setelah ', ' ketika ',
    ' seorang ', ' sebuah ', ' dalam ', ' pada ',
  ];
  const lower = s.toLowerCase();
  let hits = 0;
  for (const w of words) {
    if (lower.includes(w)) hits++;
  }
  return hits >= 3;
}

function hasCyrillic(s: string): boolean {
  return /[\u0400-\u04FF\u0500-\u052F]/.test(s);
}

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

async function runModel(
  env: Env,
  messages: AIMessage[],
  maxTokens: number,
  temperature: number
): Promise<string | null> {
  for (const model of MODELS) {
    try {
      const res = (await env.AI.run(
        model as Parameters<Ai['run']>[0],
        {
          messages,
          max_tokens: maxTokens,
          temperature,
        } as Parameters<Ai['run']>[1]
      )) as AIRunResponse;

      const text =
        (typeof res?.response === 'string' && res.response) ||
        (typeof res?.result === 'string' && res.result) ||
        '';

      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed;
    } catch (err) {
      console.warn(`[AI] ${model} failed:`, err);
    }
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

export interface SynopsisInput {
  title: string;
  originalSynopsis: string | null;
  titleEnglish?: string | null;
  year?: number | null;
  genres?: string[];
  studio?: string | null;
}

export async function generateSynopsis(
  env: Env,
  input: SynopsisInput
): Promise<string | null> {
  const cleanOriginal = input.originalSynopsis
    ? stripHtml(input.originalSynopsis)
    : '';

  const tooShort = cleanOriginal.length < 50;
  const cyrillic = cleanOriginal ? hasCyrillic(cleanOriginal) : false;
  const indonesian = cleanOriginal ? looksIndonesian(cleanOriginal) : false;

  if (!tooShort && !cyrillic && indonesian) {
    return cleanOriginal;
  }

  const contextLines: string[] = [];
  contextLines.push(`Judul: ${input.title}`);
  if (input.titleEnglish) contextLines.push(`Judul Inggris: ${input.titleEnglish}`);
  if (input.year) contextLines.push(`Tahun: ${input.year}`);
  if (input.studio) contextLines.push(`Studio: ${input.studio}`);
  if (input.genres?.length) {
    contextLines.push(`Genre: ${input.genres.slice(0, 5).join(', ')}`);
  }

  const originalBlock = cleanOriginal
    ? `\n\nSinopsis referensi (bisa Inggris/Rusia/Jepang — TULIS ULANG, bukan terjemahan literal):\n"""\n${cleanOriginal.slice(0, 2000)}\n"""`
    : '';

  const prompt =
    `Tulis sinopsis anime berikut dalam bahasa Indonesia yang natural.\n\n` +
    contextLines.join('\n') +
    originalBlock +
    `\n\nATURAN:\n` +
    `- Tulis sebagai sinopsis baru, BUKAN terjemahan literal\n` +
    `- 2-3 paragraf pendek\n` +
    `- Bahasa Indonesia natural dan mengalir\n` +
    `- Jangan spoiler\n` +
    `- Jangan tambahkan info yang tidak ada di referensi\n` +
    `- Mulai dari tokoh utama atau setting\n` +
    `- Output hanya sinopsis, tanpa penjelasan tambahan\n` +
    `- Kalau tidak yakin dengan cerita, tulis sinopsis yang generik berdasarkan genre\n\n` +
    `Sinopsis:`;

  const messages: AIMessage[] = [
    { role: 'user', content: prompt },
  ];

  const result = await withTimeout(
    runModel(env, messages, 800, 0.6),
    TIMEOUT_MS
  );

  if (!result || result.length < 50) {
    if (cleanOriginal.length >= 30) {
      return cleanOriginal;
    }
    return null;
  }

  return result;
}