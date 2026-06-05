import * as vscode from "vscode";
import { CodexAuthManager, resolveHomePath } from "./auth";
import { ChatGptCodexClient } from "./chatgptClient";
import { DEFAULT_CODEX_MODELS_ENDPOINT, DEFAULT_CODEX_RESPONSES_ENDPOINT, VENDOR_ID } from "./constants";
import { CodexModelRegistry } from "./models";
import { CodexLanguageModelProvider } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Codex OAuth LM Provider", { log: true });
  const log = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
  log("extension: activating");
  const auth = new CodexAuthManager(getAuthFilePath(), log);
  const models = new CodexModelRegistry(auth, getModelsEndpoint(), log);
  const client = new ChatGptCodexClient(auth, getEndpoint(), getInstructions, getRequestHeaderTimeoutMs, output);
  const provider = new CodexLanguageModelProvider(client, models);

  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("codexOAuthLmProvider.modelsEndpoint")
        || event.affectsConfiguration("codexOAuthLmProvider.instructions")
      ) {
        provider.refreshModels();
      }
    }),
    vscode.commands.registerCommand("codexOAuthLmProvider.checkAuth", async () => {
      try {
        const session = await auth.getSession();
        log(`command checkAuth: OK; account=${session.accountId ? "present" : "unknown"}`);
        vscode.window.showInformationMessage(
          `Codex OAuth auth OK${session.accountId ? " with ChatGPT account id" : ""}.`
        );
      } catch (error) {
        log(`command checkAuth: failed; error=${error instanceof Error ? error.message : String(error)}`);
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("codexOAuthLmProvider.listModels", async () => {
      provider.refreshModels();
      const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
      log(`command listModels: VS Code returned ${models.length} model(s): ${models.map((model) => model.id).join(",") || "none"}`);
      if (!models.length) {
        vscode.window.showWarningMessage("VS Code sees 0 Codex OAuth language models.");
        return;
      }

      vscode.window.showInformationMessage(
        `VS Code sees ${models.length} Codex OAuth model(s): ${models.map((model) => model.id).join(", ")}`
      );
    }),
    vscode.commands.registerCommand("codexOAuthLmProvider.refreshModels", async () => {
      const models = await provider.reloadModels();
      const visibleModels = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
      log(`command refreshModels: reloaded ${models.length} provider model variant(s); VS Code returned ${visibleModels.length} model(s): ${visibleModels.map((model) => model.id).join(",") || "none"}`);
      if (!models.length) {
        vscode.window.showWarningMessage("Codex OAuth model refresh failed after 3 attempts. See the Codex OAuth LM Provider output for details.");
        return;
      }

      vscode.window.showInformationMessage(
        `Codex OAuth models refreshed: ${models.map((model) => model.id).join(", ")}`
      );
    })
  );
}

export function deactivate(): void {}

function getAuthFilePath(): string {
  return resolveHomePath(getConfig().get("authFile", "~/.codex/auth.json"));
}

function getEndpoint(): string {
  return getConfig().get("endpoint", DEFAULT_CODEX_RESPONSES_ENDPOINT);
}

function getInstructions(): string {
  return getConfig().get("instructions", "You are a concise coding assistant.");
}

function getModelsEndpoint(): string {
  return getConfig().get("modelsEndpoint", DEFAULT_CODEX_MODELS_ENDPOINT);
}

function getRequestHeaderTimeoutMs(): number {
  return getConfig().get("requestHeaderTimeoutMs", 45_000);
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("codexOAuthLmProvider");
}
