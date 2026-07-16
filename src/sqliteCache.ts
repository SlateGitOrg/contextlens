import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { CachedPullRequestRecord, PullRequestComment, PullRequestSummary } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pull_requests (
  repo_key TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  html_url TEXT NOT NULL,
  author TEXT NOT NULL,
  merged_at INTEGER,
  state TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo_key, number)
);

CREATE TABLE IF NOT EXISTS pr_comments (
  id INTEGER NOT NULL,
  repo_key TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reaction_score INTEGER NOT NULL,
  is_code_review_comment INTEGER NOT NULL,
  author_is_associated INTEGER NOT NULL,
  PRIMARY KEY (repo_key, id)
);

CREATE INDEX IF NOT EXISTS idx_pr_comments_pr ON pr_comments (repo_key, pr_number);
`;

let sqlJsModulePromise: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsModulePromise) {
    // sql.js's main entry (dist/sql-wasm.js) sits directly alongside the
    // .wasm binary it needs, so resolving the module itself and taking its
    // directory is more portable across bundlers/runtimes than reaching for
    // a package.json subpath, which isn't exposed by sql.js's "exports" map.
    const sqlJsDistDir = path.dirname(require.resolve('sql.js'));
    sqlJsModulePromise = initSqlJs({
      locateFile: (file: string) => path.join(sqlJsDistDir, file),
    });
  }
  return sqlJsModulePromise as Promise<SqlJsStatic>;
}

/**
 * SQLite-backed local cache for PR metadata and comments, keyed by
 * `owner/repo` + PR number so a single cache file can safely serve every
 * repository the user opens. Backed by sql.js (WASM) rather than a native
 * addon so the extension has zero native-module install friction and the
 * test suite never touches a real filesystem lock.
 */
export class SqliteCache {
  private constructor(private readonly db: Database) {}

  static async create(existingData?: Uint8Array): Promise<SqliteCache> {
    const SQL = await getSqlJs();
    const db = existingData ? new SQL.Database(existingData) : new SQL.Database();
    db.run(SCHEMA);
    return new SqliteCache(db);
  }

  /** Serializes the current database state, e.g. to persist to disk. */
  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }

  savePullRequest(repoKey: string, record: CachedPullRequestRecord): void {
    this.db.run(
      `INSERT INTO pull_requests (repo_key, number, title, body, html_url, author, merged_at, state, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_key, number) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         html_url = excluded.html_url,
         author = excluded.author,
         merged_at = excluded.merged_at,
         state = excluded.state,
         fetched_at = excluded.fetched_at`,
      [
        repoKey,
        record.pr.number,
        record.pr.title,
        record.pr.body,
        record.pr.htmlUrl,
        record.pr.author,
        record.pr.mergedAtSeconds,
        record.pr.state,
        record.fetchedAtSeconds,
      ]
    );

    this.db.run(`DELETE FROM pr_comments WHERE repo_key = ? AND pr_number = ?`, [repoKey, record.pr.number]);

    for (const comment of record.comments) {
      this.db.run(
        `INSERT INTO pr_comments
           (id, repo_key, pr_number, author, body, created_at, reaction_score, is_code_review_comment, author_is_associated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          comment.id,
          repoKey,
          comment.prNumber,
          comment.author,
          comment.body,
          comment.createdAtSeconds,
          comment.reactionScore,
          comment.isCodeReviewComment ? 1 : 0,
          comment.authorIsAssociated ? 1 : 0,
        ]
      );
    }
  }

  /**
   * Returns the cached record if present and not older than `ttlSeconds`
   * (when `ttlSeconds` is omitted, any cached record is returned regardless
   * of age — callers decide staleness policy).
   */
  getCachedPullRequest(
    repoKey: string,
    number: number,
    nowSeconds: number,
    ttlSeconds?: number
  ): CachedPullRequestRecord | null {
    const prResult = this.db.exec(
      `SELECT number, title, body, html_url, author, merged_at, state, fetched_at
       FROM pull_requests WHERE repo_key = ? AND number = ?`,
      [repoKey, number]
    );

    if (prResult.length === 0 || prResult[0].values.length === 0) {
      return null;
    }

    const row = prResult[0].values[0];
    const fetchedAtSeconds = row[7] as number;

    if (ttlSeconds !== undefined && nowSeconds - fetchedAtSeconds > ttlSeconds) {
      return null; // stale
    }

    const pr: PullRequestSummary = {
      number: row[0] as number,
      title: row[1] as string,
      body: row[2] as string,
      htmlUrl: row[3] as string,
      author: row[4] as string,
      mergedAtSeconds: row[5] as number | null,
      state: row[6] as string,
    };

    const commentsResult = this.db.exec(
      `SELECT id, pr_number, author, body, created_at, reaction_score, is_code_review_comment, author_is_associated
       FROM pr_comments WHERE repo_key = ? AND pr_number = ? ORDER BY created_at ASC`,
      [repoKey, number]
    );

    const comments: PullRequestComment[] =
      commentsResult.length === 0
        ? []
        : commentsResult[0].values.map((r: (string | number | Uint8Array | null)[]) => ({
            id: r[0] as number,
            prNumber: r[1] as number,
            author: r[2] as string,
            body: r[3] as string,
            createdAtSeconds: r[4] as number,
            reactionScore: r[5] as number,
            isCodeReviewComment: Boolean(r[6]),
            authorIsAssociated: Boolean(r[7]),
          }));

    return { pr, comments, fetchedAtSeconds };
  }

  clearAll(): void {
    this.db.run(`DELETE FROM pull_requests`);
    this.db.run(`DELETE FROM pr_comments`);
  }

  countCachedPullRequests(repoKey: string): number {
    const result = this.db.exec(`SELECT COUNT(*) FROM pull_requests WHERE repo_key = ?`, [repoKey]);
    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  }
}
