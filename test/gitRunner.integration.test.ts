import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGitBlamePorcelain, toCommitChain } from '../src/gitBlame';
import { parseGitLog } from '../src/gitLogParser';
import { getBlamePorcelain, getGitHubRepoSlug, getRepoLog, parseGitHubRemote } from '../src/gitRunner';

/**
 * These tests exercise the real `git` binary against a throwaway repo created
 * in a temp directory — no network access, no fixtures to keep in sync with
 * git's actual output format. `git` must be on PATH (true on any dev machine
 * and standard CI images); nothing here reaches out to the network.
 */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('git integration (real repo, no network)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), 'contextlens-test-'));
    git(repoDir, ['init', '--initial-branch=main']);
    git(repoDir, ['config', 'commit.gpgsign', 'false']);

    writeFileSync(path.join(repoDir, 'example.ts'), 'export function main() {\n  return 0;\n}\n');
    git(repoDir, ['add', 'example.ts']);
    git(repoDir, ['commit', '-m', 'Add initial scaffolding']);

    writeFileSync(
      path.join(repoDir, 'example.ts'),
      'export function main() {\n  return 1; // fixed off-by-one\n}\n'
    );
    git(repoDir, ['add', 'example.ts']);
    git(repoDir, ['commit', '-m', 'Fix off-by-one error (#42)']);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('blames a real file and links the change to its PR number', async () => {
    const porcelain = await getBlamePorcelain(repoDir, 'example.ts', 2, 2);
    const lines = parseGitBlamePorcelain(porcelain);
    expect(lines).toHaveLength(1);

    const chain = toCommitChain(lines);
    expect(chain[0].summary).toBe('Fix off-by-one error (#42)');
    expect(chain[0].prNumber).toBe(42);
  });

  it('blames the unmodified line back to the first commit', async () => {
    const porcelain = await getBlamePorcelain(repoDir, 'example.ts', 1, 1);
    const lines = parseGitBlamePorcelain(porcelain);
    const chain = toCommitChain(lines);
    expect(chain[0].summary).toBe('Add initial scaffolding');
    expect(chain[0].prNumber).toBeNull();
  });

  it('reads the real repo log and finds the PR-linked commit', async () => {
    const rawLog = await getRepoLog(repoDir);
    const commits = parseGitLog(rawLog);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    const withPr = commits.filter((c) => c.prNumber !== null);
    expect(withPr).toHaveLength(1);
    expect(withPr[0].prNumber).toBe(42);
  });

  it('returns null for a repo with no origin remote', async () => {
    const slug = await getGitHubRepoSlug(repoDir);
    expect(slug).toBeNull();
  });

  it('resolves the GitHub slug once an origin remote is configured', async () => {
    git(repoDir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    const slug = await getGitHubRepoSlug(repoDir);
    expect(slug).toEqual({ owner: 'acme', repo: 'widgets' });
  });
});

describe('parseGitHubRemote', () => {
  it('parses an SSH remote URL', () => {
    expect(parseGitHubRemote('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('parses an HTTPS remote URL without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('returns null for a non-GitHub remote', () => {
    expect(parseGitHubRemote('https://gitlab.com/acme/widgets.git')).toBeNull();
  });
});
