import { describe, expect, it } from 'vitest';
import {
  GIT_LOG_FIELD_SEP,
  GIT_LOG_RECORD_SEP,
  buildPrCommitIndex,
  filterCommitsWithPr,
  parseGitLog,
} from '../src/gitLogParser';

function record(fields: string[]): string {
  return fields.join(GIT_LOG_FIELD_SEP) + GIT_LOG_RECORD_SEP;
}

describe('parseGitLog', () => {
  it('parses a single well-formed record', () => {
    const output = record(['abc123', 'Ada Lovelace', 'ada@example.com', '1700000000', 'Add feature (#7)']);
    const commits = parseGitLog(output);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      commitHash: 'abc123',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorTimeSeconds: 1700000000,
      subject: 'Add feature (#7)',
      prNumber: 7,
    });
  });

  it('parses multiple records in log order', () => {
    const output =
      record(['sha1', 'A', 'a@x.com', '100', 'first']) + record(['sha2', 'B', 'b@x.com', '200', 'second (#9)']);
    const commits = parseGitLog(output);
    expect(commits.map((c) => c.commitHash)).toEqual(['sha1', 'sha2']);
    expect(commits[1].prNumber).toBe(9);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('   \n  ')).toEqual([]);
  });

  it('skips malformed records missing fields instead of throwing', () => {
    const malformed = 'only-two-fields' + GIT_LOG_FIELD_SEP + 'x' + GIT_LOG_RECORD_SEP;
    const wellFormed = record(['sha3', 'C', 'c@x.com', '300', 'third']);
    const commits = parseGitLog(malformed + wellFormed);
    expect(commits).toHaveLength(1);
    expect(commits[0].commitHash).toBe('sha3');
  });

  it('defaults authorTimeSeconds to 0 when unparseable', () => {
    const output = record(['sha4', 'D', 'd@x.com', 'not-a-number', 'fourth']);
    const commits = parseGitLog(output);
    expect(commits[0].authorTimeSeconds).toBe(0);
  });
});

describe('filterCommitsWithPr', () => {
  it('keeps only commits referencing a PR', () => {
    const commits = parseGitLog(
      record(['sha1', 'A', 'a@x.com', '100', 'no pr here']) +
        record(['sha2', 'B', 'b@x.com', '200', 'has one (#5)'])
    );
    const withPr = filterCommitsWithPr(commits);
    expect(withPr).toHaveLength(1);
    expect(withPr[0].commitHash).toBe('sha2');
  });
});

describe('buildPrCommitIndex', () => {
  it('maps PR number to its most recent referencing commit', () => {
    const commits = parseGitLog(
      record(['sha1', 'A', 'a@x.com', '100', 'first pass (#5)']) +
        record(['sha2', 'B', 'b@x.com', '500', 'follow-up (#5)'])
    );
    const index = buildPrCommitIndex(commits);
    expect(index.size).toBe(1);
    expect(index.get(5)?.commitHash).toBe('sha2');
  });

  it('returns an empty map when no commits reference a PR', () => {
    const commits = parseGitLog(record(['sha1', 'A', 'a@x.com', '100', 'plain commit']));
    expect(buildPrCommitIndex(commits).size).toBe(0);
  });
});
