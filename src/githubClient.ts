import type { GitHubRateLimitInfo, PullRequestComment, PullRequestSummary } from './types';

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export class GitHubRateLimitError extends Error {
  constructor(public readonly resetSeconds: number) {
    super(`GitHub API rate limit exhausted; resets at ${new Date(resetSeconds * 1000).toISOString()}`);
    this.name = 'GitHubRateLimitError';
  }
}

export class GitHubApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubClientOptions {
  fetchImpl: FetchLike;
  token?: string;
  baseUrl?: string;
  /** Overridable for tests; real code sleeps via setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** Parses the standard GitHub rate-limit response headers. */
export function parseRateLimitHeaders(headers: {
  get(name: string): string | null;
}): GitHubRateLimitInfo | null {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (limit === null || remaining === null || reset === null) return null;
  return {
    limit: Number.parseInt(limit, 10),
    remaining: Number.parseInt(remaining, 10),
    resetSeconds: Number.parseInt(reset, 10),
  };
}

/**
 * Computes how long to wait before retrying a rate-limited/failed request.
 * Pure function so it can be unit tested without timers.
 *
 * - If a `retryAfterSeconds` hint is present (secondary rate limit), honor it.
 * - Otherwise use exponential backoff with a 30s cap.
 */
export function computeBackoffMs(attempt: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base;
}

const GITHUB_BOT_LIKE = /\[bot\]$/i;

/**
 * Thin, dependency-injected GitHub REST client scoped to what ContextLens
 * needs: a PR's description and its comments (both issue-level and
 * review-line-level), plus rate-limit-aware retry handling.
 */
export class GitHubClient {
  private readonly fetchImpl: FetchLike;
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private lastRateLimit: GitHubRateLimitInfo | null = null;

  constructor(options: GitHubClientOptions) {
    this.fetchImpl = options.fetchImpl;
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  getLastRateLimit(): GitHubRateLimitInfo | null {
    return this.lastRateLimit;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async requestJson(path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() });
      const rateLimit = parseRateLimitHeaders(res.headers);
      if (rateLimit) this.lastRateLimit = rateLimit;

      if (res.ok) {
        return res.json();
      }

      const isPrimaryRateLimit = res.status === 403 && rateLimit?.remaining === 0;
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
      const isSecondaryRateLimit = res.status === 403 && retryAfterSeconds !== null;
      const isRetryableServerError = res.status >= 500;

      if (isPrimaryRateLimit && rateLimit) {
        throw new GitHubRateLimitError(rateLimit.resetSeconds);
      }

      if ((isSecondaryRateLimit || isRetryableServerError) && attempt < this.maxRetries) {
        const waitMs = computeBackoffMs(attempt, retryAfterSeconds);
        await this.sleep(waitMs);
        attempt++;
        continue;
      }

      throw new GitHubApiError(res.status, `GitHub API request to ${path} failed with ${res.status}`);
    }
  }

  async fetchPullRequest(owner: string, repo: string, number: number): Promise<PullRequestSummary> {
    const data = (await this.requestJson(`/repos/${owner}/${repo}/pulls/${number}`)) as {
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      user: { login: string };
      merged_at: string | null;
      state: string;
    };

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      htmlUrl: data.html_url,
      author: data.user.login,
      mergedAtSeconds: data.merged_at ? Math.floor(new Date(data.merged_at).getTime() / 1000) : null,
      state: data.state,
    };
  }

  async fetchPullRequestComments(
    owner: string,
    repo: string,
    number: number
  ): Promise<PullRequestComment[]> {
    const [issueComments, reviewComments] = await Promise.all([
      this.requestJson(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`) as Promise<
        GitHubRawComment[]
      >,
      this.requestJson(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`) as Promise<
        GitHubRawComment[]
      >,
    ]);

    const fromIssue = issueComments.map((c) => toPullRequestComment(c, number, false));
    const fromReview = reviewComments.map((c) => toPullRequestComment(c, number, true));
    return [...fromIssue, ...fromReview];
  }
}

interface GitHubRawComment {
  id: number;
  user: { login: string; type?: string };
  body: string;
  created_at: string;
  reactions?: { '+1'?: number; '-1'?: number; heart?: number; hooray?: number };
  author_association?: string;
}

function toPullRequestComment(
  raw: GitHubRawComment,
  prNumber: number,
  isCodeReviewComment: boolean
): PullRequestComment {
  const reactions = raw.reactions ?? {};
  const reactionScore =
    (reactions['+1'] ?? 0) + (reactions.heart ?? 0) + (reactions.hooray ?? 0) - (reactions['-1'] ?? 0);

  const association = raw.author_association ?? 'NONE';
  const authorIsAssociated =
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association) || GITHUB_BOT_LIKE.test(raw.user.login);

  return {
    id: raw.id,
    prNumber,
    author: raw.user.login,
    body: raw.body,
    createdAtSeconds: Math.floor(new Date(raw.created_at).getTime() / 1000),
    reactionScore,
    isCodeReviewComment,
    authorIsAssociated,
  };
}
