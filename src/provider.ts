import * as vscode from "vscode";
import { ChatGptCodexClient } from "./chatgptClient";
import { CodexModelInfo, CodexModelRegistry, toCodexModelId, toVsCodeModelId } from "./models";

type CodexLanguageModelChatInformation = vscode.LanguageModelChatInformation & {
  readonly codexModelId: string;
  readonly reasoningEffort?: string;
};

const DEFAULT_MAX_INPUT_TOKENS = 200000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export class CodexLanguageModelProvider implements vscode.LanguageModelChatProvider<CodexLanguageModelChatInformation> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(
    private readonly client: ChatGptCodexClient,
    private readonly models: CodexModelRegistry
  ) {}

  refreshModels(): void {
    this.models.refresh();
    this.changeEmitter.fire();
  }

  async reloadModels(): Promise<CodexLanguageModelChatInformation[]> {
    const models = await this.models.reload();
    this.changeEmitter.fire();
    return models.flatMap(toVsCodeModels);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<CodexLanguageModelChatInformation[]> {
    const models = await this.models.getModels();
    return models.flatMap(toVsCodeModels);
  }

  async provideLanguageModelChatResponse(
    model: CodexLanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.client.streamText(model.codexModelId ?? toCodexModelId(model.id), messages, options, progress, token, model.reasoningEffort);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTokenCount(text);
    }

    return estimateTokenCount(requestMessageText(text));
  }
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function requestMessageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        return JSON.stringify(part.input ?? {});
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        return part.content
          .map(toolResultContentText)
          .filter((value): value is string => Boolean(value?.trim()))
          .join("\n\n");
      }

      return "";
    })
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
}

function toolResultContentText(content: unknown): string | undefined {
  if (content instanceof vscode.LanguageModelTextPart) {
    return content.value;
  }

  if (typeof content === "string") {
    return content;
  }

  return undefined;
}

function toVsCodeModels(model: CodexModelInfo): CodexLanguageModelChatInformation[] {
  const efforts = model.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : model.defaultReasoningEffort
      ? [{ effort: model.defaultReasoningEffort, description: undefined }]
      : [];

  if (!efforts.length) {
    return [toVsCodeModel(model)];
  }

  return efforts
    .map((effort) => toVsCodeModel(model, effort));
}

function toVsCodeModel(
  model: CodexModelInfo,
  effort?: { effort: string; description?: string }
): CodexLanguageModelChatInformation {
  return {
    id: effort ? `${toVsCodeModelId(model.id)}.${effort.effort}` : toVsCodeModelId(model.id),
    name: effort ? `${model.name} (${formatEffortName(effort.effort)})` : model.name,
    family: toVsCodeModelId(model.id),
    detail: effort?.effort === model.defaultReasoningEffort ? "via Codex OAuth, default thinking" : "via Codex OAuth",
    tooltip: modelTooltip(model, effort),
    version: "1",
    maxInputTokens: model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    capabilities: {
      imageInput: model.inputModalities?.includes("image"),
      toolCalling: true
    },
    codexModelId: model.id,
    reasoningEffort: effort?.effort
  };
}

function modelTooltip(model: CodexModelInfo, effort?: { effort: string; description?: string }): string {
  return [
    `Model: ${model.id}`,
    `VS Code ID: ${effort ? `${toVsCodeModelId(model.id)}.${effort.effort}` : toVsCodeModelId(model.id)}`,
    `Provider: OpenAI Codex OAuth`,
    `Source: ${model.source}`,
    effort ? `Thinking effort: ${effort.effort}` : undefined,
    effort?.description,
    model.contextWindow ? `Context window: ${model.contextWindow}` : undefined,
    model.maxContextWindow ? `Max context window: ${model.maxContextWindow}` : undefined,
    model.effectiveContextWindowPercent ? `Effective context: ${model.effectiveContextWindowPercent}%` : undefined,
    model.inputModalities?.length ? `Input modalities: ${model.inputModalities.join(", ")}` : undefined,
    model.description
  ].filter(Boolean).join("\n");
}

function formatEffortName(effort: string): string {
  if (effort === "xhigh") {
    return "Extra High";
  }

  return effort
    .split(/[-_]/)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
