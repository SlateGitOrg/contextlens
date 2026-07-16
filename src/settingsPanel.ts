import * as vscode from 'vscode';

export const GITHUB_TOKEN_SECRET_KEY = 'contextlens.githubToken';

/**
 * Webview-based settings panel for entering the GitHub token used to fetch
 * PR descriptions/comments. The token is written to VS Code's SecretStorage
 * (encrypted at rest by the OS keychain) rather than to `settings.json`, so
 * it never ends up committed to source control or synced in plaintext.
 */
export class ContextLensSettingsPanel {
  private static current: ContextLensSettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static async show(context: vscode.ExtensionContext): Promise<void> {
    if (ContextLensSettingsPanel.current) {
      ContextLensSettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'contextlensSettings',
      'ContextLens Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ContextLensSettingsPanel.current = new ContextLensSettingsPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (message: { type: string; token?: string }) => {
        if (message.type === 'saveToken' && typeof message.token === 'string') {
          await this.context.secrets.store(GITHUB_TOKEN_SECRET_KEY, message.token.trim());
          void vscode.window.showInformationMessage('ContextLens: GitHub token saved securely.');
        } else if (message.type === 'clearToken') {
          await this.context.secrets.delete(GITHUB_TOKEN_SECRET_KEY);
          void vscode.window.showInformationMessage('ContextLens: GitHub token cleared.');
        }
      },
      null,
      this.disposables
    );

    this.render();
  }

  private render(): void {
    this.panel.webview.html = getHtml();
  }

  private dispose(): void {
    ContextLensSettingsPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}

function getHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 1.5rem; color: var(--vscode-foreground); }
  h1 { font-size: 1.1rem; }
  input { width: 100%; padding: 6px; margin: 8px 0; box-sizing: border-box; }
  button { padding: 6px 14px; margin-right: 8px; cursor: pointer; }
  p.hint { opacity: 0.75; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>ContextLens Settings</h1>
  <p class="hint">
    Create a fine-grained GitHub token with read-only access to Pull requests, then paste it below.
    It is stored in your OS keychain via VS Code SecretStorage — never written to settings.json.
  </p>
  <input id="token" type="password" placeholder="ghp_... or github_pat_..." />
  <div>
    <button id="save">Save token</button>
    <button id="clear">Clear token</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('save').addEventListener('click', () => {
      const token = document.getElementById('token').value;
      vscode.postMessage({ type: 'saveToken', token });
    });
    document.getElementById('clear').addEventListener('click', () => {
      document.getElementById('token').value = '';
      vscode.postMessage({ type: 'clearToken' });
    });
  </script>
</body>
</html>`;
}
