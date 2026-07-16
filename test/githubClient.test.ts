import { describe, expect, it, vi } from 'vitest';
import {
  GitHubApiError,
  GitHubClient,
  GitHubRateLimitError,
  computeBackoffMs,
  parseRateLimitHeaders,
} from '../src/githubClient';
import type { FetchLike } from '../src/githubClient';

function headersFrom(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

function fakeFetch(
  responses: Array<{
    ok: boolean;
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  }>
): FetchLike {
  let call = 0;
  return async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.ok,
      status: r.status,
      headers: headersFrom(r.headers ?? {}),
      json: async () => r.body,
    };
  };
}

describe('parseRateLimitHeaders', () => {
  it('parses well-formed headers', () => {
    const headers = headersFrom({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1700000000',
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      limit: 5000,
      remaining: 4999,
      resetSeconds: 1700000000,
    });
  });

  it('returns null when headers are missing', () => {
    expect(parseRateLimitHeaders(headersFrom({}))).toBeNull();
  });
});

describe('computeBackoffMs', () => {
  it('honors an explicit retry-after hint', () => {
    expect(computeBackoffMs(0, 5)).toBe(5000);
  });

  it('uses exponential backoff without a hint', () => {
    expect(computeBackoffMs(0)).toBe(500);
    expect(computeBackoffMs(1)).toBe(1000);
    expect(computeBackoffMs(2)).toBe(2000);
  });

  it('caps backoff at 30 seconds', () => {
    expect(computeBackoffMs(10)).toBe(30000);
  });
});

describe('GitHubClient.fetchPullRequest', () => {
  it('maps a successful response into a PullRequestSummary', async () => {
    const fetchImpl = fakeFetch([
      {
        ok: true,
        status: 200,
        headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4998', 'x-ratelimit-reset': '1700000000' },
        body: {
          number: 42,
          title: 'Fix flaky test',
          body: 'Because the CI runner is slow on cold cache.',
          html_url: 'https://github.com/acme/repo/pull/42',
          user: { login: 'octocat' },
          merged_at: '2024-01-01T00:00:00Z',
          state: 'closed',
        },
      },
    ]);
    const client = new GitHubClient({ fetchImpl, token: 'test-token' });
    const pr = await client.fetchPullRequest('acme', 'repo', 42);
    expect(pr.number).toBe(42);
    expect(pr.author).toBe('octocat');
    expect(pr.mergedAtSeconds).toBe(Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000));
    expect(client.getLastRateLimit()).toEqual({ limit: 5000, remaining: 4998, resetSeconds: 1700000000 });
  });

  it('throws GitHubRateLimitError on primary rate-limit exhaustion', async () => {
    const fetchImpl = fakeFetch([
      {
        ok: false,
        status: 403,
        headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700003600' },
      },
    ]);
    const client = new GitHubClient({ fetchImpl });
    await expect(client.fetchPullRequest('acme', 'repo', 1)).rejects.toThrow(GitHubRateLimitError);
  });

  it('retries on secondary rate limit honoring retry-after, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = fakeFetch([
      { ok: false, status: 403, headers: { 'retry-after': '2' } },
      {
        ok: true,
        status: 200,
        body: {
          number: 1,
          title: 'Test',
          body: '',
          html_url: 'https://github.com/acme/repo/pull/1',
          user: { login: 'octocat' },
          merged_at: null,
          state: 'open',
        },
      },
    ]);
    const client = new GitHubClient({ fetchImpl, sleep });
    const pr = await client.fetchPullRequest('acme', 'repo', 1);
    expect(pr.number).toBe(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries on 5xx server errors up to maxRetries, then throws GitHubApiError', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = fakeFetch([{ ok: false, status: 503 }]);
    const client = new GitHubClient({ fetchImpl, sleep, maxRetries: 2 });
    await expect(client.fetchPullRequest('acme', 'repo', 1)).rejects.toThrow(GitHubApiError);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a plain 404', async () => {
    const sleep = vi.fn();
    const fetchImpl = fakeFetch([{ ok: false, status: 404 }]);
    const client = new GitHubClient({ fetchImpl, sleep });
    await expect(client.fetchPullRequest('acme', 'repo', 999)).rejects.toThrow(GitHubApiError);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('GitHubClient.fetchPullRequestComments', () => {
  it('merges issue comments and review comments, tagging each appropriately', async () => {
    let call = 0;
    const fetchImpl: FetchLike = async (url) => {
      call++;
      const isReview = url.includes('/pulls/');
      return {
        ok: true,
        status: 200,
        headers: headersFrom({}),
        json: async () =>
          isReview
            ? [
                {
                  id: 2,
                  user: { login: 'reviewer' },
                  body: 'Nit: rename this variable.',
                  created_at: '2024-01-02T00:00:00Z',
                  reactions: { '+1': 1 },
                  author_association: 'COLLABORATOR',
                },
              ]
            : [
                {
                  id: 1,
                  user: { login: 'author' },
                  body: 'Explaining why this approach was chosen because of legacy constraints.',
                  created_at: '2024-01-01T00:00:00Z',
                  reactions: { '+1': 2, heart: 1, '-1': 1 },
                  author_association: 'OWNER',
                },
              ],
      };
    };
    const client = new GitHubClient({ fetchImpl });
    const comments = await client.fetchPullRequestComments('acme', 'repo', 10);
    expect(call).toBe(2);
    expect(comments).toHaveLength(2);
    const issue = comments.find((c) => c.id === 1)!;
    const review = comments.find((c) => c.id === 2)!;
    expect(issue.isCodeReviewComment).toBe(false);
    expect(issue.authorIsAssociated).toBe(true);
    expect(issue.reactionScore).toBe(2); // 2 + 1 - 1
    expect(review.isCodeReviewComment).toBe(true);
  });
});
