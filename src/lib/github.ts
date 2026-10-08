import type { Env, FileToCommit, CommitResult } from '../types';

const API_BASE = 'https://api.github.com';

function b64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function b64Decode(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yukio-api/2.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

interface GithubFileResponse {
  sha: string;
  content: string;
  encoding: string;
  path: string;
}

interface GitRefResponse {
  object: { sha: string; type: string; url: string };
}

interface GitCommitResponse {
  sha: string;
  tree: { sha: string; url: string };
}

interface GitBlobResponse {
  sha: string;
}

interface GitTreeResponse {
  sha: string;
  truncated: boolean;
}

export interface GithubFile {
  path: string;
  sha: string;
  content: string;
}

export async function githubGetFile(
  env: Env,
  path: string
): Promise<GithubFile | null> {
  const url = `${API_BASE}/repos/${env.YUKIO_DATA_REPO}/contents/${path}?ref=${env.YUKIO_DATA_BRANCH}`;

  const res = await fetch(url, { headers: headers(env) });

  if (res.status === 404) return null;

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub GET ${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as GithubFileResponse;
  return {
    path: data.path,
    sha: data.sha,
    content: b64Decode(data.content),
  };
}

export async function githubCommitFile(
  env: Env,
  path: string,
  content: string,
  message: string
): Promise<CommitResult> {
  const repo = env.YUKIO_DATA_REPO;
  const branch = env.YUKIO_DATA_BRANCH;

  let sha: string | undefined;
  try {
    const existing = await githubGetFile(env, path);
    if (existing) sha = existing.sha;
  } catch {}

  const body: Record<string, unknown> = {
    message,
    content: b64Encode(content),
    branch,
  };
  if (sha) body.sha = sha;

  const url = `${API_BASE}/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 300)}` };
  }

  const data = (await res.json()) as {
    commit?: { sha: string; html_url: string };
  };

  return {
    ok: true,
    sha: data.commit?.sha,
    commitUrl: data.commit?.html_url,
  };
}

export async function githubCommitMultipleFiles(
  env: Env,
  files: FileToCommit[],
  message: string
): Promise<CommitResult> {
  if (files.length === 0) {
    return { ok: false, error: 'No files to commit' };
  }

  if (files.length === 1) {
    const f = files[0]!;
    return githubCommitFile(env, f.path, f.content, message);
  }

  const repo = env.YUKIO_DATA_REPO;
  const branch = env.YUKIO_DATA_BRANCH;
  const base = `${API_BASE}/repos/${repo}`;
  const h = headers(env);

  try {
    const refRes = await fetch(`${base}/git/ref/heads/${branch}`, {
      headers: h,
    });
    if (!refRes.ok) {
      return { ok: false, error: `Get ref failed: HTTP ${refRes.status}` };
    }
    const refData = (await refRes.json()) as GitRefResponse;
    const parentCommitSha = refData.object.sha;

    const commitRes = await fetch(`${base}/git/commits/${parentCommitSha}`, {
      headers: h,
    });
    if (!commitRes.ok) {
      return { ok: false, error: `Get commit failed: HTTP ${commitRes.status}` };
    }
    const commitData = (await commitRes.json()) as GitCommitResponse;
    const baseTreeSha = commitData.tree.sha;

    const blobResults = await Promise.all(
      files.map(async (f) => {
        const res = await fetch(`${base}/git/blobs`, {
          method: 'POST',
          headers: { ...h, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: b64Encode(f.content),
            encoding: 'base64',
          }),
        });
        if (!res.ok) {
          throw new Error(`Blob ${f.path} failed: HTTP ${res.status}`);
        }
        const data = (await res.json()) as GitBlobResponse;
        return { path: f.path, sha: data.sha };
      })
    );

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: blobResults.map((b) => ({
          path: b.path,
          mode: '100644',
          type: 'blob',
          sha: b.sha,
        })),
      }),
    });
    if (!treeRes.ok) {
      return { ok: false, error: `Create tree failed: HTTP ${treeRes.status}` };
    }
    const treeData = (await treeRes.json()) as GitTreeResponse;

    const newCommitRes = await fetch(`${base}/git/commits`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        tree: treeData.sha,
        parents: [parentCommitSha],
      }),
    });
    if (!newCommitRes.ok) {
      return {
        ok: false,
        error: `Create commit failed: HTTP ${newCommitRes.status}`,
      };
    }
    const newCommitData = (await newCommitRes.json()) as GitCommitResponse;

    const updateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitData.sha, force: false }),
    });
    if (!updateRes.ok) {
      return { ok: false, error: `Update ref failed: HTTP ${updateRes.status}` };
    }

    return {
      ok: true,
      sha: newCommitData.sha,
      commitUrl: `https://github.com/${repo}/commit/${newCommitData.sha}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message ?? 'unknown',
    };
  }
}