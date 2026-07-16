import { extractPrNumber } from './gitBlame';

/**
 * Field/record separators used when invoking git so that commit messages
 * containing arbitrary punctuation (quotes, pipes, commas) never corrupt
 * parsing. Callers should invoke git as:
 *
 *   git log --format=<GIT_LOG_FORMAT> [revrange] [-- path]
 *
 * GIT_LOG_FORMAT below expands to the equivalent literal format string.
 */
export const GIT_LOG_FIELD_SEP = '\x1f';
export const GIT_LOG_RECORD_SEP = '\x1e';
export const GIT_LOG_FORMAT = `%H${GIT_LOG_FIELD_SEP}%an${GIT_LOG_FIELD_SEP}%ae${GIT_LOG_FIELD_SEP}%at${GIT_LOG_FIELD_SEP}%s${GIT_LOG_RECORD_SEP}`;

export interface ParsedCommit {
  commitHash: string;
  authorName: string;
  authorEmail: string;
  authorTimeSeconds: number;
  subject: string;
  prNumber: number | null;
}

/**
 * Parses `git log --format=GIT_LOG_FORMAT` output into structured commits.
 * Tolerant of a trailing newline/record separator and of empty input.
 */
export function parseGitLog(output: string): ParsedCommit[] {
  if (!output || output.trim().length === 0) {
    return [];
  }

  const records = output.split(GIT_LOG_RECORD_SEP).filter((r) => r.replace(/\n/g, '').length > 0);

  const commits: ParsedCommit[] = [];
  for (const rawRecord of records) {
    // Each record may be preceded by a leftover newline from the previous
    // record separator; strip leading/trailing whitespace/newlines only,
    // never interior content (commit subjects can't contain our separators).
    const record = rawRecord.replace(/^\n+/, '');
    const fields = record.split(GIT_LOG_FIELD_SEP);
    if (fields.length < 5) {
      continue; // malformed record, skip defensively
    }
    const [commitHash, authorName, authorEmail, authorTimeRaw, subject] = fields;
    const authorTimeSeconds = Number.parseInt(authorTimeRaw, 10);
    commits.push({
      commitHash: commitHash.trim(),
      authorName,
      authorEmail,
      authorTimeSeconds: Number.isNaN(authorTimeSeconds) ? 0 : authorTimeSeconds,
      subject: subject.replace(/\n+$/, ''),
      prNumber: extractPrNumber(subject),
    });
  }

  return commits;
}

/** Returns only the commits that reference a pull request, in log order. */
export function filterCommitsWithPr(commits: ParsedCommit[]): ParsedCommit[] {
  return commits.filter((c) => c.prNumber !== null);
}

/** Builds a map of PR number -> most recent commit that references it. */
export function buildPrCommitIndex(commits: ParsedCommit[]): Map<number, ParsedCommit> {
  const index = new Map<number, ParsedCommit>();
  for (const commit of commits) {
    if (commit.prNumber === null) continue;
    const existing = index.get(commit.prNumber);
    if (!existing || commit.authorTimeSeconds > existing.authorTimeSeconds) {
      index.set(commit.prNumber, commit);
    }
  }
  return index;
}
