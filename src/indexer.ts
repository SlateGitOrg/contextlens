import * as vscode from 'vscode';
import { buildPrCommitIndex, filterCommitsWithPr, parseGitLog } from './gitLogParser';
import { getGitHubRepoSlug, getRepoLog } from './gitRunner';
import { GitHubRateLimitError, type GitHubClient } from './githubClient';
import type { SqliteCache } from './sqliteCache';

export interface IndexerOptions {
  repoRoot: string;
  cache: SqliteCache;
  githubClient: GitHubClient | null;
  hasToken: boolean;
  cacheTtlSeconds: number;
  /** Cap on how many distinct PRs get pre-warmed per indexing pass, to stay well under rate limits. */
  maxPrsToWarm: number;
}

export interface IndexResult {
  totalCommitsScanned: number;
  distinctPrsFound: number;
  prsWarmed: number;
  stoppedEarlyDueToRateLimit: boolean;
}

/**
 * Runs a background indexing pass: walks recent git log history to discover
 * which PR numbers are referenced by merge/squash commits, then pre-warms
 * the SQLite cache for the most recent ones so hovering feels instant. Shown
 * to the user via VS Code's progress notification API.
 */
export async function runBackgroundIndex(options: IndexerOptions): Promise<IndexResult> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ContextLens: indexing repository history',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Reading git log…' });
      const rawLog = await getRepoLog(options.repoRoot);
      const commits = parseGitLog(rawLog);
      const withPr = filterCommitsWithPr(commits);
      const prIndex = buildPrCommitIndex(withPr);

      const result: IndexResult = {
        totalCommitsScanned: commits.length,
        distinctPrsFound: prIndex.size,
        prsWarmed: 0,
        stoppedEarlyDueToRateLimit: false,
      };

      if (!options.hasToken || !options.githubClient) {
        return result;
      }

      const slug = await getGitHubRepoSlug(options.repoRoot);
      if (!slug) {
        return result;
      }
      const repoKey = `${slug.owner}/${slug.repo}`;

      const sortedPrNumbers = Array.from(prIndex.keys()).sort((a, b) => b - a);
      const toWarm = sortedPrNumbers.slice(0, options.maxPrsToWarm);
      const now = Math.floor(Date.now() / 1000);

      for (const prNumber of toWarm) {
        if (token.isCancellationRequested) break;

        const cached = options.cache.getCachedPullRequest(repoKey, prNumber, now, options.cacheTtlSeconds);
        if (cached) {
          progress.report({ increment: 100 / toWarm.length, message: `PR #${prNumber} (cached)` });
          continue;
        }

        try {
          const [pr, prComments] = await Promise.all([
            options.githubClient.fetchPullRequest(slug.owner, slug.repo, prNumber),
            options.githubClient.fetchPullRequestComments(slug.owner, slug.repo, prNumber),
          ]);
          options.cache.savePullRequest(repoKey, { pr, comments: prComments, fetchedAtSeconds: now });
          result.prsWarmed++;
          progress.report({ increment: 100 / toWarm.length, message: `PR #${prNumber} indexed` });
        } catch (err) {
          if (err instanceof GitHubRateLimitError) {
            result.stoppedEarlyDueToRateLimit = true;
            break;
          }
          // Non-fatal: skip this PR (deleted, private fork, etc.) and continue.
        }
      }

      return result;
    }
  );
}
