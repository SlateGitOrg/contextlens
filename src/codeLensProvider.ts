import * as vscode from 'vscode';
import { parseGitBlamePorcelain, toCommitChain } from './gitBlame';
import { getBlamePorcelain } from './gitRunner';

/**
 * Shows a lightweight "Last touched by X in PR #123" CodeLens above function
 * and class declarations so the context is visible without hovering. It
 * intentionally reuses only the blame layer (no network) — the hover
 * provider is responsible for the richer, PR-comment-fetching view.
 */
export class ContextLensCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private readonly getRepoRoot: () => string | null, private readonly isEnabled: () => boolean) {}

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.isEnabled()) return [];
    const repoRoot = this.getRepoRoot();
    if (!repoRoot || document.uri.scheme !== 'file') return [];

    const declarationLines = findDeclarationLines(document);
    if (declarationLines.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const line of declarationLines.slice(0, 40)) {
      try {
        const porcelain = await getBlamePorcelain(repoRoot, document.uri.fsPath, line, line);
        const commits = toCommitChain(parseGitBlamePorcelain(porcelain));
        const top = commits[0];
        if (!top) continue;

        const range = new vscode.Range(line - 1, 0, line - 1, 0);
        const label =
          top.commitHash === '0000000000000000000000000000000000000000'
            ? 'Uncommitted change'
            : `Last touched by ${top.authorName}${top.prNumber ? ` in PR #${top.prNumber}` : ''}`;

        lenses.push(
          new vscode.CodeLens(range, {
            title: label,
            command: 'contextlens.openSettings',
            tooltip: top.summary,
          })
        );
      } catch {
        // Skip lines that fail to blame (e.g. binary files, edge cases).
      }
    }
    return lenses;
  }
}

/** Very small heuristic: lines that look like a function/class/method opener. */
function findDeclarationLines(document: vscode.TextDocument): number[] {
  const pattern =
    /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+\w|class\s+\w|(public|private|protected)\s+\w+\s*\()/;
  const lines: number[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    if (pattern.test(document.lineAt(i).text)) {
      lines.push(i + 1);
    }
  }
  return lines;
}
