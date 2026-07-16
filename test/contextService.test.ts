import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextService } from '../src/contextService';
import { GitHubClient } from '../src/githubClient';
import type { FetchLike } from '../src/githubClient';
import { SqliteCache } from '../src/sqliteCache';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function fakePrResponseFetch(): FetchLike {
  return async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      if (url.includes('/pulls/42') && !url.includes('/comments')) {
        return {
          number: 42,
          title: 'Fix off-by-one error',
          body: 'The loop bound was wrong because it used `<` instead of `<=`.',
          html_url: 'https://github.com/acme/widgets/pull/42',
          user: { login: 'octocat' },
          merged_at: '2024-01-01T00:00:00Z',
          state: 'closed',
        };
      }
      if (url.includes('/issues/42/comments')) {
        return [
          {
            id: 1,
            user: { login: 'octocat' },
            body: 'Confirmed this was the root cause because the tests only cover the happy path.',
            created_at: '2024-01-01T01:00:00Z',
            reactions: { '+1': 3 },
            author_association: 'OWNER',
          },
        ];
      }
      if (url.includes('/pulls/42/comments')) {
        return [];
      }
      return {};
    },
  });
}

describe('ContextService', () => {
  let repoDir: string;
  let cache: SqliteCache;

  beforeEach(async () => {
    repoDir = mkdtempSync(path.join(tmpdir(), 'contextlens-ctx-'));
    git(repoDir, ['init', '--initial-branch=main']);
    git(repoDir, ['config', 'commit.gpgsign', 'false']);
    git(repoDir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);

    writeFileSync(path.join(repoDir, 'example.ts'), 'export function main() {\n  return 0;\n}\n');
    git(repoDir, ['add', 'example.ts']);
    git(repoDir, ['commit', '-m', 'Add initial scaffolding']);

    writeFileSync(path.join(repoDir, 'example.ts'), 'export function main() {\n  return 1;\n}\n');
    git(repoDir, ['add', 'example.ts']);
    git(repoDir, ['commit', '-m', 'Fix off-by-one error (#42)']);

    cache = await SqliteCache.create();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    cache.close();
  });

  it('returns blame with no PR data when the line has no linked PR', async () => {
    const service = new ContextService({
      repoRoot: repoDir,
      cache,
      githubClient: null,
      hasToken: false,
      cacheTtlSeconds: 3600,
      maxComments: 3,
    });

    const ctx = await service.getLineContext('example.ts', 1, 1);
    expect(ctx.linkedPrNumber).toBeNull();
    expect(ctx.pr).toBeNull();
  });

  it('reports needsToken when a PR is linked but no token is configured', async () => {
    const service = new ContextService({
      repoRoot: repoDir,
      cache,
      githubClient: null,
      hasToken: false,
      cacheTtlSeconds: 3600,
      maxComments: 3,
    });

    const ctx = await service.getLineContext('example.ts', 2, 2);
    expect(ctx.linkedPrNumber).toBe(42);
    expect(ctx.needsToken).toBe(true);
    expect(ctx.pr).toBeNull();
  });

  it('fetches, ranks, and caches PR data end to end on a cold cache', async () => {
    const githubClient = new GitHubClient({ fetchImpl: fakePrResponseFetch(), token: 'fake-token' });
    const service = new ContextService({
      repoRoot: repoDir,
      cache,
      githubClient,
      hasToken: true,
      cacheTtlSeconds: 3600,
      maxComments: 3,
    });

    const ctx = await service.getLineContext('example.ts', 2, 2);
    expect(ctx.pr?.number).toBe(42);
    expect(ctx.pr?.title).toBe('Fix off-by-one error');
    expect(ctx.topComments).toHaveLength(1);
    expect(ctx.topComments[0].body).toContain('root cause');

    // Second lookup should be served entirely from cache (no PR refetch needed
    // to observe this — assert the cache actually now holds the record).
    expect(cache.countCachedPullRequests('acme/widgets')).toBe(1);
  });

  it('serves from cache on a warm lookup without needing the client again', async () => {
    const now = Math.floor(Date.now() / 1000);
    cache.savePullRequest('acme/widgets', {
      pr: {
        number: 42,
        title: 'Cached title',
        body: 'cached body',
        htmlUrl: 'https://github.com/acme/widgets/pull/42',
        author: 'octocat',
        mergedAtSeconds: now,
        state: 'closed',
      },
      comments: [],
      fetchedAtSeconds: now,
    });

    const service = new ContextService({
      repoRoot: repoDir,
      cache,
      githubClient: null,
      hasToken: false,
      cacheTtlSeconds: 3600,
      nowSeconds: () => now,
      maxComments: 3,
    });

    const ctx = await service.getLineContext('example.ts', 2, 2);
    expect(ctx.pr?.title).toBe('Cached title');
    expect(ctx.needsToken).toBe(false);
  });

  it('surfaces a rate-limit signal instead of throwing', async () => {
    const rateLimitedFetch: FetchLike = async () => ({
      ok: false,
      status: 403,
      headers: {
        get: (name: string) =>
          (
            {
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1700000000',
            } as Record<string, string>
          )[name.toLowerCase()] ?? null,
      },
      json: async () => ({}),
    });
    const githubClient = new GitHubClient({ fetchImpl: rateLimitedFetch, token: 'fake-token' });
    const service = new ContextService({
      repoRoot: repoDir,
      cache,
      githubClient,
      hasToken: true,
      cacheTtlSeconds: 3600,
      maxComments: 3,
    });

    const ctx = await service.getLineContext('example.ts', 2, 2);
    expect(ctx.rateLimited).toEqual({ resetSeconds: 1700000000 });
    expect(ctx.pr).toBeNull();
  });

  it('propagates non-rate-limit errors from the GitHub client', async () => {
    const failingFetch: FetchLike = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({}),
    });
    const githubClient = new GitHubClient({
      fetchImpl: failingFetch,
      token: 'fake-token',
      maxRetries: 0,
      sleep: async () => {},
    });
    const service = new ContextService({
      repoRoot: repoDir,
      cache,
      githubClient,
      hasToken: true,
      cacheTtlSeconds: 3600,
      maxComments: 3,
    });

    await expect(service.getLineContext('example.ts', 2, 2)).rejects.toThrow();
  });
});
