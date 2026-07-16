import type { BlameLine } from './types';

const ZERO_HASH = '0000000000000000000000000000000000000000';
const SHA_HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

interface MutableCommitMeta {
  authorName: string;
  authorEmail: string;
  authorTimeSeconds: number;
  summary: string;
}

/**
 * Parses the output of `git blame --line-porcelain <file>` into a flat list
 * of per-line attributions.
 *
 * The porcelain format emits a full commit header (author, author-mail,
 * author-time, summary, ...) the first time a commit is encountered, then
 * only a shortened header (just the sha/line-number triplet + filename) on
 * subsequent lines attributed to the same commit. This parser tracks commit
 * metadata as it streams through so every returned line is fully populated
 * regardless of which form it appeared in.
 */
export function parseGitBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split('\n');
  const commitCache = new Map<string, MutableCommitMeta>();
  const result: BlameLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i];
    if (headerLine === '' || headerLine === undefined) {
      i++;
      continue;
    }

    const match = SHA_HEADER_RE.exec(headerLine);
    if (!match) {
      // Not a header we recognize (shouldn't happen in well-formed output).
      i++;
      continue;
    }

    const commitHash = match[1];
    const finalLine = Number.parseInt(match[3], 10);
    i++;

    let meta = commitCache.get(commitHash);
    const partial: Partial<MutableCommitMeta> = {};

    // Consume metadata lines until we hit the tab-prefixed content line.
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const line = lines[i];
      if (line.startsWith('author ')) {
        partial.authorName = line.slice('author '.length);
      } else if (line.startsWith('author-mail ')) {
        partial.authorEmail = line.slice('author-mail '.length).replace(/^<|>$/g, '');
      } else if (line.startsWith('author-time ')) {
        partial.authorTimeSeconds = Number.parseInt(line.slice('author-time '.length), 10);
      } else if (line.startsWith('summary ')) {
        partial.summary = line.slice('summary '.length);
      }
      i++;
    }

    if (!meta) {
      meta = {
        authorName: partial.authorName ?? 'Unknown',
        authorEmail: partial.authorEmail ?? '',
        authorTimeSeconds: partial.authorTimeSeconds ?? 0,
        summary: partial.summary ?? '',
      };
      commitCache.set(commitHash, meta);
    } else {
      // Merge in anything newly seen (rare, but keeps behavior robust).
      if (partial.authorName) meta.authorName = partial.authorName;
      if (partial.authorEmail) meta.authorEmail = partial.authorEmail;
      if (partial.authorTimeSeconds) meta.authorTimeSeconds = partial.authorTimeSeconds;
      if (partial.summary) meta.summary = partial.summary;
    }

    // The content line itself (tab + text). We don't need the text content,
    // only that we've reached and consumed it.
    if (i < lines.length && lines[i].startsWith('\t')) {
      i++;
    }

    result.push({
      line: finalLine,
      commitHash,
      authorName: meta.authorName,
      authorEmail: meta.authorEmail,
      authorTimeSeconds: meta.authorTimeSeconds,
      summary: meta.summary,
      isUncommitted: commitHash === ZERO_HASH,
    });
  }

  return result;
}

/**
 * Extracts a PR number from a merge/squash commit summary line, matching the
 * two conventions GitHub produces:
 *   - "Merge pull request #123 from user/branch"
 *   - "Some feature title (#123)"  (squash-merge default message)
 */
export function extractPrNumber(summary: string): number | null {
  const mergeMatch = /Merge pull request #(\d+)/.exec(summary);
  if (mergeMatch) {
    return Number.parseInt(mergeMatch[1], 10);
  }
  const squashMatch = /\(#(\d+)\)\s*$/.exec(summary.trim());
  if (squashMatch) {
    return Number.parseInt(squashMatch[1], 10);
  }
  return null;
}

/** Narrows a full blame dump down to the lines in [startLine, endLine] (inclusive, 1-based). */
export function sliceBlameRange(
  blameLines: BlameLine[],
  startLine: number,
  endLine: number
): BlameLine[] {
  return blameLines.filter((l) => l.line >= startLine && l.line <= endLine);
}

/** Deduplicates blame lines into an ordered (newest-first) list of distinct commits. */
export function toCommitChain(blameLines: BlameLine[]): {
  commitHash: string;
  authorName: string;
  authorEmail: string;
  authorTimeSeconds: number;
  summary: string;
  prNumber: number | null;
}[] {
  const seen = new Set<string>();
  const chain: {
    commitHash: string;
    authorName: string;
    authorEmail: string;
    authorTimeSeconds: number;
    summary: string;
    prNumber: number | null;
  }[] = [];

  for (const l of blameLines) {
    if (seen.has(l.commitHash)) continue;
    seen.add(l.commitHash);
    chain.push({
      commitHash: l.commitHash,
      authorName: l.authorName,
      authorEmail: l.authorEmail,
      authorTimeSeconds: l.authorTimeSeconds,
      summary: l.summary,
      prNumber: extractPrNumber(l.summary),
    });
  }

  // Newest first.
  chain.sort((a, b) => b.authorTimeSeconds - a.authorTimeSeconds);
  return chain;
}
