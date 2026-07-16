import { describe, expect, it } from 'vitest';
import {
  extractPrNumber,
  parseGitBlamePorcelain,
  sliceBlameRange,
  toCommitChain,
} from '../src/gitBlame';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

/** Builds a realistic `git blame --line-porcelain` fragment for one commit/line. */
function blockFor(opts: {
  sha: string;
  origLine: number;
  finalLine: number;
  numLines?: number;
  author: string;
  email: string;
  time: number;
  summary: string;
  content: string;
  includeFullHeader: boolean;
}): string {
  const headerCounts = opts.numLines ? ` ${opts.numLines}` : '';
  let block = `${opts.sha} ${opts.origLine} ${opts.finalLine}${headerCounts}\n`;
  if (opts.includeFullHeader) {
    block += `author ${opts.author}\n`;
    block += `author-mail <${opts.email}>\n`;
    block += `author-time ${opts.time}\n`;
    block += `author-tz +0000\n`;
    block += `committer ${opts.author}\n`;
    block += `committer-mail <${opts.email}>\n`;
    block += `committer-time ${opts.time}\n`;
    block += `committer-tz +0000\n`;
    block += `summary ${opts.summary}\n`;
  }
  block += `filename src/example.ts\n`;
  block += `\t${opts.content}\n`;
  return block;
}

describe('parseGitBlamePorcelain', () => {
  it('parses a single-commit block with full header', () => {
    const output = blockFor({
      sha: SHA_A,
      origLine: 1,
      finalLine: 1,
      numLines: 3,
      author: 'Ada Lovelace',
      email: 'ada@example.com',
      time: 1700000000,
      summary: 'Add initial scaffolding',
      content: 'export function main() {',
      includeFullHeader: true,
    });

    const lines = parseGitBlamePorcelain(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      line: 1,
      commitHash: SHA_A,
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorTimeSeconds: 1700000000,
      summary: 'Add initial scaffolding',
      isUncommitted: false,
    });
  });

  it('fills in metadata for repeated commits that omit the full header', () => {
    const first = blockFor({
      sha: SHA_A,
      origLine: 1,
      finalLine: 1,
      numLines: 2,
      author: 'Ada Lovelace',
      email: 'ada@example.com',
      time: 1700000000,
      summary: 'Add initial scaffolding',
      content: 'export function main() {',
      includeFullHeader: true,
    });
    // Second line of the same commit: porcelain omits the full header.
    const second = blockFor({
      sha: SHA_A,
      origLine: 2,
      finalLine: 2,
      author: 'Ada Lovelace',
      email: 'ada@example.com',
      time: 1700000000,
      summary: 'Add initial scaffolding',
      content: '  return 0;',
      includeFullHeader: false,
    });

    const lines = parseGitBlamePorcelain(first + second);
    expect(lines).toHaveLength(2);
    expect(lines[1].line).toBe(2);
    // Metadata backfilled from the commit cache, not re-declared in the block.
    expect(lines[1].authorName).toBe('Ada Lovelace');
    expect(lines[1].summary).toBe('Add initial scaffolding');
  });

  it('flags the all-zero hash as an uncommitted change', () => {
    const output = blockFor({
      sha: ZERO,
      origLine: 5,
      finalLine: 5,
      numLines: 1,
      author: 'Not Committed Yet',
      email: 'you@example.com',
      time: 1700000001,
      summary: '',
      content: 'const x = 1;',
      includeFullHeader: true,
    });

    const lines = parseGitBlamePorcelain(output);
    expect(lines[0].isUncommitted).toBe(true);
  });

  it('handles multiple distinct commits across a range', () => {
    const output =
      blockFor({
        sha: SHA_A,
        origLine: 1,
        finalLine: 1,
        numLines: 1,
        author: 'Ada Lovelace',
        email: 'ada@example.com',
        time: 1700000000,
        summary: 'Add initial scaffolding',
        content: 'line one',
        includeFullHeader: true,
      }) +
      blockFor({
        sha: SHA_B,
        origLine: 1,
        finalLine: 2,
        numLines: 1,
        author: 'Grace Hopper',
        email: 'grace@example.com',
        time: 1700001000,
        summary: 'Fix off-by-one (#42)',
        content: 'line two',
        includeFullHeader: true,
      });

    const lines = parseGitBlamePorcelain(output);
    expect(lines.map((l) => l.commitHash)).toEqual([SHA_A, SHA_B]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseGitBlamePorcelain('')).toEqual([]);
  });
});

describe('extractPrNumber', () => {
  it('extracts from a merge commit message', () => {
    expect(extractPrNumber('Merge pull request #123 from acme/fix-bug')).toBe(123);
  });

  it('extracts from a squash-merge message', () => {
    expect(extractPrNumber('Add dark mode support (#456)')).toBe(456);
  });

  it('returns null when no PR reference is present', () => {
    expect(extractPrNumber('Quick fix for typo')).toBeNull();
  });

  it('does not match a parenthetical number without a hash', () => {
    expect(extractPrNumber('Bump version (2)')).toBeNull();
  });
});

describe('sliceBlameRange', () => {
  it('filters lines to the inclusive range', () => {
    const lines = [1, 2, 3, 4, 5].map((n) => ({
      line: n,
      commitHash: SHA_A,
      authorName: 'x',
      authorEmail: 'x@x.com',
      authorTimeSeconds: 0,
      summary: '',
      isUncommitted: false,
    }));
    const sliced = sliceBlameRange(lines, 2, 4);
    expect(sliced.map((l) => l.line)).toEqual([2, 3, 4]);
  });
});

describe('toCommitChain', () => {
  it('dedupes and sorts newest-first, extracting PR numbers', () => {
    const lines = [
      {
        line: 1,
        commitHash: SHA_A,
        authorName: 'Ada',
        authorEmail: 'ada@x.com',
        authorTimeSeconds: 1000,
        summary: 'Old commit (#1)',
        isUncommitted: false,
      },
      {
        line: 2,
        commitHash: SHA_B,
        authorName: 'Grace',
        authorEmail: 'grace@x.com',
        authorTimeSeconds: 2000,
        summary: 'Newer commit (#2)',
        isUncommitted: false,
      },
      {
        line: 3,
        commitHash: SHA_A,
        authorName: 'Ada',
        authorEmail: 'ada@x.com',
        authorTimeSeconds: 1000,
        summary: 'Old commit (#1)',
        isUncommitted: false,
      },
    ];

    const chain = toCommitChain(lines);
    expect(chain).toHaveLength(2);
    expect(chain[0].commitHash).toBe(SHA_B); // newest first
    expect(chain[0].prNumber).toBe(2);
    expect(chain[1].prNumber).toBe(1);
  });
});
