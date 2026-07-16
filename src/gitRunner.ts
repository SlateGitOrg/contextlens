import { execFile } from 'node:child_process';
import { GIT_LOG_FORMAT } from './gitLogParser';

/** Runs `git <args>` in `cwd` and resolves with stdout, rejecting on non-zero exit. */
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 1024 * 1024 * 64, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Raw `git blame --line-porcelain` output for a file, optionally scoped to a line range. */
export async function getBlamePorcelain(
  cwd: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  const args = ['blame', '--line-porcelain'];
  if (startLine !== undefined && endLine !== undefined) {
    args.push('-L', `${startLine},${endLine}`);
  }
  args.push('--', filePath);
  return runGit(cwd, args);
}

/** Raw `git log` output across the whole repo (or a path), in the ContextLens field format. */
export async function getRepoLog(cwd: string, pathspec?: string, maxCount = 5000): Promise<string> {
  const args = ['log', `--format=${GIT_LOG_FORMAT}`, `--max-count=${maxCount}`];
  if (pathspec) {
    args.push('--', pathspec);
  }
  return runGit(cwd, args);
}

/** Resolves the `owner/repo` slug from a repo's `origin` remote, or null if not GitHub-hosted. */
export async function getGitHubRepoSlug(cwd: string): Promise<{ owner: string; repo: string } | null> {
  let remoteUrl: string;
  try {
    remoteUrl = (await runGit(cwd, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return null;
  }
  return parseGitHubRemote(remoteUrl);
}

/** Parses owner/repo out of common GitHub remote URL forms (https, ssh, git protocol). */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const patterns = [
    /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/, // ssh or https, with or without .git
  ];
  for (const re of patterns) {
    const match = re.exec(remoteUrl.trim());
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}
