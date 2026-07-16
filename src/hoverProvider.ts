import * as vscode from 'vscode';
import type { ContextService, LineContext } from './contextService';
import type { BlameCommit } from './types';

function formatDate(seconds: number): string {
  if (!seconds) return 'unknown date';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function renderChain(commits: BlameCommit[]): string {
  const top = commits[0];
  if (!top) return '';
  if (top.commitHash === '0000000000000000000000000000000000000000') {
    return `**Uncommitted change** — not yet part of the repository history.\n\n`;
  }
  const shortHash = top.commitHash.slice(0, 7);
  let text = `**${top.summary || '(no summary)'}**  \n`;
  text += `${top.authorName} · ${formatDate(top.authorTimeSeconds)} · \`${shortHash}\`\n\n`;

  if (commits.length > 1) {
    text += `<details><summary>${commits.length - 1} earlier revision(s)</summary>\n\n`;
    for (const c of commits.slice(1, 6)) {
      text += `- ${c.summary || '(no summary)'} — ${c.authorName}, ${formatDate(c.authorTimeSeconds)} (\`${c.commitHash.slice(0, 7)}\`)\n`;
    }
    text += `\n</details>\n\n`;
  }
  return text;
}

function renderPr(ctx: LineContext): string {
  if (ctx.rateLimited) {
    const resetAt = new Date(ctx.rateLimited.resetSeconds * 1000).toLocaleTimeString();
    return `_GitHub API rate limit reached. Cached data will resume being used automatically; live lookups resume at ${resetAt}._\n\n`;
  }
  if (ctx.needsToken) {
    return `_Add a GitHub token via **ContextLens: Open Settings** to load PR #${ctx.linkedPrNumber} description and comments._\n\n`;
  }
  if (!ctx.pr) {
    return '';
  }

  let text = `---\n\n### [#${ctx.pr.number} ${ctx.pr.title}](${ctx.pr.htmlUrl})\n\n`;
  if (ctx.pr.body) {
    const truncated = ctx.pr.body.length > 500 ? `${ctx.pr.body.slice(0, 500)}…` : ctx.pr.body;
    text += `${truncated}\n\n`;
  }

  if (ctx.topComments.length > 0) {
    text += `**Top discussion:**\n\n`;
    for (const c of ctx.topComments) {
      const body = c.body.length > 300 ? `${c.body.slice(0, 300)}…` : c.body;
      text += `> ${body.replace(/\n/g, '\n> ')}\n> — **${c.author}**${c.isCodeReviewComment ? ' (review comment)' : ''}\n\n`;
    }
  }

  return text;
}

export class ContextLensHoverProvider implements vscode.HoverProvider {
  constructor(private readonly getService: () => ContextService | null) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const service = this.getService();
    if (!service) return undefined;
    if (document.isUntitled || document.uri.scheme !== 'file') return undefined;

    const line = position.line + 1; // vscode is 0-based, git blame is 1-based
    try {
      const ctx = await service.getLineContext(document.uri.fsPath, line, line);
      if (ctx.chain.commits.length === 0) return undefined;

      const markdown = new vscode.MarkdownString(renderChain(ctx.chain.commits) + renderPr(ctx), true);
      markdown.isTrusted = true;
      markdown.supportHtml = true;
      return new vscode.Hover(markdown);
    } catch {
      return undefined;
    }
  }
}
