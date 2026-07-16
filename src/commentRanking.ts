import type { PullRequestComment, RankedComment } from './types';

/**
 * Heuristic weights for the comment-ranking algorithm. Exposed so tests (and
 * eventually a settings UI) can tune behavior without touching the scoring
 * logic itself.
 */
export interface RankingWeights {
  reactionWeight: number;
  associatedAuthorBonus: number;
  codeReviewBonus: number;
  explanatoryKeywordBonus: number;
  lowSignalPenalty: number;
  tooLongPenaltyPerChar: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  reactionWeight: 2,
  associatedAuthorBonus: 3,
  codeReviewBonus: 4,
  explanatoryKeywordBonus: 5,
  lowSignalPenalty: -6,
  tooLongPenaltyPerChar: 0.01,
};

/** Comments that are pure ceremony and carry no explanatory value. */
const LOW_SIGNAL_PATTERNS = [
  /^lgtm!?$/i,
  /^\+1$/,
  /^looks good( to me)?!?$/i,
  /^nice!?$/i,
  /^done\.?$/i,
  /^ship it!?$/i,
  /^approved?\.?$/i,
];

/** Words that correlate strongly with a comment explaining *why*, not just *what*. */
const EXPLANATORY_KEYWORDS = [
  'because',
  'why',
  'since',
  'in order to',
  'workaround',
  'root cause',
  'the reason',
  'note that',
  'careful',
  'gotcha',
  'edge case',
  'otherwise',
  'due to',
  'so that',
];

const IDEAL_MIN_LENGTH = 40;
const IDEAL_MAX_LENGTH = 600;

function isLowSignal(body: string): boolean {
  const trimmed = body.trim();
  return LOW_SIGNAL_PATTERNS.some((re) => re.test(trimmed));
}

function countExplanatoryKeywords(body: string): number {
  const lower = body.toLowerCase();
  let count = 0;
  for (const kw of EXPLANATORY_KEYWORDS) {
    if (lower.includes(kw)) count++;
  }
  return count;
}

/**
 * Scores a single comment. Higher is more likely to explain *why* the code
 * looks the way it does, which is what a hover card should surface first.
 */
export function scoreComment(
  comment: PullRequestComment,
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS
): number {
  const body = comment.body ?? '';
  let score = 0;

  score += comment.reactionScore * weights.reactionWeight;

  if (comment.authorIsAssociated) {
    score += weights.associatedAuthorBonus;
  }

  if (comment.isCodeReviewComment) {
    score += weights.codeReviewBonus;
  }

  const keywordHits = countExplanatoryKeywords(body);
  score += keywordHits * weights.explanatoryKeywordBonus;

  if (isLowSignal(body)) {
    score += weights.lowSignalPenalty;
  }

  const length = body.trim().length;
  if (length < IDEAL_MIN_LENGTH) {
    // Short-but-not-ceremonial comments get a mild penalty proportional to
    // how far below the informative threshold they fall.
    score -= (IDEAL_MIN_LENGTH - length) * 0.05;
  } else if (length > IDEAL_MAX_LENGTH) {
    score -= (length - IDEAL_MAX_LENGTH) * weights.tooLongPenaltyPerChar;
  }

  return Math.round(score * 100) / 100;
}

/**
 * Ranks and sorts comments highest-score-first. Ties break by most recent
 * first so that, all else equal, the latest word on a topic wins.
 */
export function rankComments(
  comments: PullRequestComment[],
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS
): RankedComment[] {
  return comments
    .map((c) => ({ ...c, score: scoreComment(c, weights) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.createdAtSeconds - a.createdAtSeconds;
    });
}

/** Convenience: top-N ranked comments, defaulting to 3 (hover card default). */
export function topComments(
  comments: PullRequestComment[],
  limit = 3,
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS
): RankedComment[] {
  return rankComments(comments, weights).slice(0, limit);
}
