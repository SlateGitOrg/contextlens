import { sliceBlameRange, toCommitChain } from './gitBlame';
import { getBlamePorcelain, getGitHubRepoSlug } from './gitRunner';
import { parseGitBlamePorcelain } from './gitBlame';
import { GitHubClient, GitHubRateLimitError } from './githubClient';
import { topComments } from './commentRanking';
import type { SqliteCache } from './sqliteCache';
import type { BlameChain, CachedPullRequestRecord, RankedComment } from './types';

export interface LineContext {
  chain: BlameChain;
  /** The nearest ancestor commit that carries a resolvable PR number, if any. */
  linkedPrNumber: number | null;
  pr: CachedPullRequestRecord['pr'] | null;
  topComments: RankedComment[];
  /** Set when the PR/comment fetch was skipped because of an active rate limit. */
  rateLimited: { resetSeconds: number } | null;
  /** Set when no GitHub token is configured and a network fetch would be required. */
  needsToken: boolean;
}

export interface ContextServiceOptions {
  repoRoot: string;
  cache: SqliteCache;
  githubClient: GitHubClient | null;
  hasToken: boolean;
  cacheTtlSeconds: number;
  maxComments: number;
  nowSeconds?: () => number;
}

/**
 * Orchestrates the full "why is this line here" lookup: blame the range,
 * find the newest commit with a PR reference, resolve that PR (cache-first,
 * network as fallback), and rank its comments for display.
 */
export class ContextService {
  constructor(private readonly options: ContextServiceOptions) {}

  async getLineContext(filePath: string, startLine: number, endLine: number): Promise<LineContext> {
    const porcelain = await getBlamePorcelain(this.options.repoRoot, filePath, startLine, endLine);
    const blameLines = sliceBlameRange(parseGitBlamePorcelain(porcelain), startLine, endLine);
    const commits = toCommitChain(blameLines);

    const chain: BlameChain = { filePath, startLine, endLine, commits };
    const linkedCommit = commits.find((c) => c.prNumber !== null) ?? null;
    const linkedPrNumber = linkedCommit?.prNumber ?? null;

    if (linkedPrNumber === null) {
      return { chain, linkedPrNumber: null, pr: null, topComments: [], rateLimited: null, needsToken: false };
    }

    const slug = await getGitHubRepoSlug(this.options.repoRoot);
    if (!slug) {
      return { chain, linkedPrNumber, pr: null, topComments: [], rateLimited: null, needsToken: false };
    }
    const repoKey = `${slug.owner}/${slug.repo}`;
    const now = (this.options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

    const cached = this.options.cache.getCachedPullRequest(
      repoKey,
      linkedPrNumber,
      now,
      this.options.cacheTtlSeconds
    );
    if (cached) {
      return {
        chain,
        linkedPrNumber,
        pr: cached.pr,
        topComments: topComments(cached.comments, this.options.maxComments),
        rateLimited: null,
        needsToken: false,
      };
    }

    if (!this.options.hasToken || !this.options.githubClient) {
      return { chain, linkedPrNumber, pr: null, topComments: [], rateLimited: null, needsToken: true };
    }

    try {
      const [pr, comments] = await Promise.all([
        this.options.githubClient.fetchPullRequest(slug.owner, slug.repo, linkedPrNumber),
        this.options.githubClient.fetchPullRequestComments(slug.owner, slug.repo, linkedPrNumber),
      ]);
      this.options.cache.savePullRequest(repoKey, { pr, comments, fetchedAtSeconds: now });
      return {
        chain,
        linkedPrNumber,
        pr,
        topComments: topComments(comments, this.options.maxComments),
        rateLimited: null,
        needsToken: false,
      };
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        return {
          chain,
          linkedPrNumber,
          pr: null,
          topComments: [],
          rateLimited: { resetSeconds: err.resetSeconds },
          needsToken: false,
        };
      }
      throw err;
    }
  }
}
