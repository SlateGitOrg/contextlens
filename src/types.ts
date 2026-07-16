/**
 * Shared domain types for ContextLens. This module has zero dependency on
 * the `vscode` API so it can be imported from pure unit tests.
 */

/** A single entry produced by `git blame --line-porcelain`. */
export interface BlameLine {
  /** 1-based line number in the *current* revision of the file. */
  line: number;
  commitHash: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds, as reported by git. */
  authorTimeSeconds: number;
  summary: string;
  /** True when git could not attribute the line to a real commit (working tree edit). */
  isUncommitted: boolean;
}

/** One commit in a blame chain, deduplicated and enriched. */
export interface BlameCommit {
  commitHash: string;
  authorName: string;
  authorEmail: string;
  authorTimeSeconds: number;
  summary: string;
  /** Pull request number this commit was merged through, if detected. */
  prNumber: number | null;
}

/** The full ancestry of a hovered line/range: newest commit first. */
export interface BlameChain {
  filePath: string;
  startLine: number;
  endLine: number;
  commits: BlameCommit[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  author: string;
  mergedAtSeconds: number | null;
  state: string;
}

export interface PullRequestComment {
  id: number;
  prNumber: number;
  author: string;
  body: string;
  createdAtSeconds: number;
  /** Total reaction count (thumbs up + heart + hooray, minus thumbs down). */
  reactionScore: number;
  /** True if the comment is anchored to a specific diff line (review comment). */
  isCodeReviewComment: boolean;
  /** True if the PR author or a repo maintainer wrote it. */
  authorIsAssociated: boolean;
}

export interface RankedComment extends PullRequestComment {
  score: number;
}

export interface GitHubRateLimitInfo {
  limit: number;
  remaining: number;
  /** Unix seconds when the limit resets. */
  resetSeconds: number;
}

export interface CachedPullRequestRecord {
  pr: PullRequestSummary;
  comments: PullRequestComment[];
  fetchedAtSeconds: number;
}
