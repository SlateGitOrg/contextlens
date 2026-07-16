import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKING_WEIGHTS, rankComments, scoreComment, topComments } from '../src/commentRanking';
import type { PullRequestComment } from '../src/types';

function comment(overrides: Partial<PullRequestComment>): PullRequestComment {
  return {
    id: 1,
    prNumber: 1,
    author: 'someone',
    body: 'A comment',
    createdAtSeconds: 1700000000,
    reactionScore: 0,
    isCodeReviewComment: false,
    authorIsAssociated: false,
    ...overrides,
  };
}

describe('scoreComment', () => {
  it('penalizes low-signal ceremony comments like LGTM', () => {
    const lgtm = comment({ body: 'LGTM' });
    const explanatory = comment({
      body: 'We do it this way because the upstream API silently truncates payloads over 1MB, so batching is required here to avoid data loss.',
    });
    expect(scoreComment(explanatory)).toBeGreaterThan(scoreComment(lgtm));
  });

  it('rewards explanatory keywords', () => {
    const plain = comment({ body: 'Updated the function signature to accept an options object.' });
    const explained = comment({
      body: 'Updated the function signature to accept an options object because otherwise every caller needed updating whenever we added a parameter.',
    });
    expect(scoreComment(explained)).toBeGreaterThan(scoreComment(plain));
  });

  it('rewards reactions proportionally to the configured weight', () => {
    const noReactions = comment({ body: 'This is a moderately informative comment about the change.' });
    const withReactions = comment({
      body: 'This is a moderately informative comment about the change.',
      reactionScore: 5,
    });
    const diff = scoreComment(withReactions) - scoreComment(noReactions);
    expect(diff).toBeCloseTo(5 * DEFAULT_RANKING_WEIGHTS.reactionWeight, 5);
  });

  it('rewards association (maintainer/author) comments', () => {
    const outsider = comment({ body: 'Some feedback about the approach taken here in this PR.' });
    const maintainer = comment({
      body: 'Some feedback about the approach taken here in this PR.',
      authorIsAssociated: true,
    });
    expect(scoreComment(maintainer)).toBeGreaterThan(scoreComment(outsider));
  });

  it('rewards code review (line-anchored) comments over general discussion', () => {
    const general = comment({ body: 'General thought about the overall direction of this change.' });
    const reviewComment = comment({
      body: 'General thought about the overall direction of this change.',
      isCodeReviewComment: true,
    });
    expect(scoreComment(reviewComment)).toBeGreaterThan(scoreComment(general));
  });

  it('penalizes excessively long comments beyond the ideal length', () => {
    const reasonable = comment({ body: 'x'.repeat(200) });
    const tooLong = comment({ body: 'x'.repeat(2000) });
    expect(scoreComment(tooLong)).toBeLessThan(scoreComment(reasonable));
  });

  it('is deterministic for identical input', () => {
    const c = comment({ body: 'Same input every time', reactionScore: 2 });
    expect(scoreComment(c)).toBe(scoreComment(c));
  });
});

describe('rankComments', () => {
  it('sorts comments highest score first', () => {
    const low = comment({ id: 1, body: 'LGTM' });
    const high = comment({
      id: 2,
      body: 'This works around a known bug in the upstream parser because it chokes on trailing commas, so we normalize input first.',
      reactionScore: 3,
      authorIsAssociated: true,
    });
    const ranked = rankComments([low, high]);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('breaks ties by most recent first', () => {
    const a = comment({ id: 1, body: 'identical body text here', createdAtSeconds: 100 });
    const b = comment({ id: 2, body: 'identical body text here', createdAtSeconds: 200 });
    const ranked = rankComments([a, b]);
    expect(ranked[0].id).toBe(2);
  });

  it('does not mutate the input array', () => {
    const comments = [comment({ id: 1 }), comment({ id: 2 })];
    const copy = [...comments];
    rankComments(comments);
    expect(comments).toEqual(copy);
  });
});

describe('topComments', () => {
  it('respects the limit parameter', () => {
    const comments = Array.from({ length: 10 }, (_, i) =>
      comment({ id: i, body: `Comment number ${i} explaining something because of reasons.` })
    );
    expect(topComments(comments, 3)).toHaveLength(3);
  });

  it('defaults to 3 when no limit is given', () => {
    const comments = Array.from({ length: 5 }, (_, i) => comment({ id: i }));
    expect(topComments(comments)).toHaveLength(3);
  });

  it('returns fewer than the limit when input is smaller', () => {
    expect(topComments([comment({ id: 1 })], 3)).toHaveLength(1);
  });
});
