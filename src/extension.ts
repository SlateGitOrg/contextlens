import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ContextService } from './contextService';
import { GitHubClient, type FetchLike } from './githubClient';
import { ContextLensHoverProvider } from './hoverProvider';
import { ContextLensCodeLensProvider } from './codeLensProvider';
import { runBackgroundIndex } from './indexer';
import { SqliteCache } from './sqliteCache';
import { ContextLensSettingsPanel, GITHUB_TOKEN_SECRET_KEY } from './settingsPanel';

let cache: SqliteCache | null = null;
let cacheFilePath: string | null = null;

function getRepoRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

async function loadOrCreateCache(context: vscode.ExtensionContext): Promise<SqliteCache> {
  cacheFilePath = path.join(context.globalStorageUri.fsPath, 'contextlens-cache.sqlite');
  fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });

  let existing: Uint8Array | undefined;
  if (fs.existsSync(cacheFilePath)) {
    existing = new Uint8Array(fs.readFileSync(cacheFilePath));
  }
  return SqliteCache.create(existing);
}

function persistCache(): void {
  if (cache && cacheFilePath) {
    fs.writeFileSync(cacheFilePath, Buffer.from(cache.export()));
  }
}

async function buildGitHubClient(context: vscode.ExtensionContext): Promise<{
  client: GitHubClient | null;
  hasToken: boolean;
}> {
  const token = await context.secrets.get(GITHUB_TOKEN_SECRET_KEY);
  if (!token) return { client: null, hasToken: false };

  const fetchImpl: FetchLike = (input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>;
  return { client: new GitHubClient({ fetchImpl, token }), hasToken: true };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  cache = await loadOrCreateCache(context);

  const config = vscode.workspace.getConfiguration('contextlens');
  let { client: githubClient, hasToken } = await buildGitHubClient(context);

  const buildService = (): ContextService | null => {
    const repoRoot = getRepoRoot();
    if (!repoRoot || !cache) return null;
    return new ContextService({
      repoRoot,
      cache,
      githubClient,
      hasToken,
      cacheTtlSeconds: vscode.workspace.getConfiguration('contextlens').get<number>('cacheTtlHours', 168) * 3600,
      maxComments: vscode.workspace.getConfiguration('contextlens').get<number>('maxCommentsPerHover', 3),
    });
  };

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new ContextLensHoverProvider(buildService))
  );

  const codeLensProvider = new ContextLensCodeLensProvider(
    () => getRepoRoot(),
    () => vscode.workspace.getConfiguration('contextlens').get<boolean>('showCodeLens', true)
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('contextlens.openSettings', async () => {
      await ContextLensSettingsPanel.show(context);
    }),

    vscode.commands.registerCommand('contextlens.clearCache', () => {
      cache?.clearAll();
      persistCache();
      void vscode.window.showInformationMessage('ContextLens: local cache cleared.');
    }),

    vscode.commands.registerCommand('contextlens.reindexRepository', async () => {
      const repoRoot = getRepoRoot();
      if (!repoRoot || !cache) {
        void vscode.window.showWarningMessage('ContextLens: open a folder that is a git repository first.');
        return;
      }
      const result = await runBackgroundIndex({
        repoRoot,
        cache,
        githubClient,
        hasToken,
        cacheTtlSeconds: config.get<number>('cacheTtlHours', 168) * 3600,
        maxPrsToWarm: 50,
      });
      persistCache();
      void vscode.window.showInformationMessage(
        `ContextLens: scanned ${result.totalCommitsScanned} commits, found ${result.distinctPrsFound} PR references, warmed ${result.prsWarmed}.` +
          (result.stoppedEarlyDueToRateLimit ? ' Stopped early due to GitHub rate limit.' : '')
      );
      codeLensProvider.refresh();
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('contextlens')) {
        codeLensProvider.refresh();
      }
    }),

    context.secrets.onDidChange(async (e) => {
      if (e.key === GITHUB_TOKEN_SECRET_KEY) {
        const rebuilt = await buildGitHubClient(context);
        githubClient = rebuilt.client;
        hasToken = rebuilt.hasToken;
      }
    })
  );

  // Kick off a background indexing pass on repo open, without blocking activation.
  const repoRoot = getRepoRoot();
  if (repoRoot) {
    void runBackgroundIndex({
      repoRoot,
      cache,
      githubClient,
      hasToken,
      cacheTtlSeconds: config.get<number>('cacheTtlHours', 168) * 3600,
      maxPrsToWarm: 30,
    })
      .then(() => persistCache())
      .catch((err) => {
        console.error('ContextLens: background indexing failed', err);
      });
  }
}

export function deactivate(): void {
  persistCache();
  cache?.close();
  cache = null;
}
