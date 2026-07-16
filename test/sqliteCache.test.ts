import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteCache } from '../src/sqliteCache';
import type { CachedPullRequestRecord } from '../src/types';

function record(overrides: Partial<CachedPullRequestRecord['pr']> = {}): CachedPullRequestRecord {
  return {
    pr: {
      number: 42,
      title: 'Fix flaky test',
      body: 'Because CI is slow.',
      htmlUrl: 'https://github.com/acme/repo/pull/42',
      author: 'octocat',
      mergedAtSeconds: 1700000000,
      state: 'closed',
      ...overrides,
    },
    comments: [
      {
        id: 1,
        prNumber: 42,
        author: 'reviewer',
        body: 'Looks good because it fixes the race condition.',
        createdAtSeconds: 1700000100,
        reactionScore: 2,
        isCodeReviewComment: true,
        authorIsAssociated: true,
      },
    ],
    fetchedAtSeconds: 1700000200,
  };
}

describe('SqliteCache', () => {
  let cache: SqliteCache;

  beforeEach(async () => {
    cache = await SqliteCache.create();
  });

  it('returns null for a PR that was never cached', () => {
    expect(cache.getCachedPullRequest('acme/repo', 999, 1700000000)).toBeNull();
  });

  it('round-trips a saved PR and its comments', () => {
    cache.savePullRequest('acme/repo', record());
    const fetched = cache.getCachedPullRequest('acme/repo', 42, 1700000300);
    expect(fetched).not.toBeNull();
    expect(fetched!.pr.title).toBe('Fix flaky test');
    expect(fetched!.comments).toHaveLength(1);
    expect(fetched!.comments[0].body).toContain('race condition');
  });

  it('scopes cached records by repo key so identical PR numbers do not collide', () => {
    cache.savePullRequest('acme/repo-a', record());
    cache.savePullRequest('acme/repo-b', record({ title: 'Different repo, same PR number' }));

    const a = cache.getCachedPullRequest('acme/repo-a', 42, 1700000300);
    const b = cache.getCachedPullRequest('acme/repo-b', 42, 1700000300);
    expect(a!.pr.title).toBe('Fix flaky test');
    expect(b!.pr.title).toBe('Different repo, same PR number');
  });

  it('treats a record as stale once it exceeds the TTL', () => {
    cache.savePullRequest('acme/repo', record());
    const fresh = cache.getCachedPullRequest('acme/repo', 42, 1700000300, 3600);
    const stale = cache.getCachedPullRequest('acme/repo', 42, 1700010000, 3600);
    expect(fresh).not.toBeNull();
    expect(stale).toBeNull();
  });

  it('overwrites comments on re-save rather than appending duplicates', () => {
    cache.savePullRequest('acme/repo', record());
    const updated = record();
    updated.comments = [
      {
        id: 2,
        prNumber: 42,
        author: 'someone-else',
        body: 'A newer comment.',
        createdAtSeconds: 1700000500,
        reactionScore: 0,
        isCodeReviewComment: false,
        authorIsAssociated: false,
      },
    ];
    cache.savePullRequest('acme/repo', updated);

    const fetched = cache.getCachedPullRequest('acme/repo', 42, 1700000600);
    expect(fetched!.comments).toHaveLength(1);
    expect(fetched!.comments[0].id).toBe(2);
  });

  it('clearAll empties both tables', () => {
    cache.savePullRequest('acme/repo', record());
    cache.clearAll();
    expect(cache.getCachedPullRequest('acme/repo', 42, 1700000300)).toBeNull();
    expect(cache.countCachedPullRequests('acme/repo')).toBe(0);
  });

  it('exports and reloads the database from a binary snapshot', async () => {
    cache.savePullRequest('acme/repo', record());
    const bytes = cache.export();

    const reloaded = await SqliteCache.create(bytes);
    const fetched = reloaded.getCachedPullRequest('acme/repo', 42, 1700000300);
    expect(fetched!.pr.number).toBe(42);
    reloaded.close();
  });

  it('counts cached PRs per repo', () => {
    cache.savePullRequest('acme/repo', record());
    // Real GitHub comment IDs are globally unique per repo, so the second
    // PR's record must not reuse comment id 1 from the first.
    const second = record({ number: 43 });
    second.pr.number = 43;
    second.comments = [{ ...second.comments[0], id: 2, prNumber: 43 }];
    cache.savePullRequest('acme/repo', second);
    expect(cache.countCachedPullRequests('acme/repo')).toBe(2);
  });
});
