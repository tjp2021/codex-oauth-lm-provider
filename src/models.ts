import { CodexAuthManager } from "./auth";

export type CodexModelInfo = {
  id: string;
  name: string;
  description?: string;
  priority?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  maxContextWindow?: number;
  effectiveContextWindowPercent?: number;
  inputModalities?: string[];
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexReasoningEffort[];
  source: "codex-api";
};

export const VSCODE_MODEL_ID_PREFIX = "codex-oauth.";

export type CodexReasoningEffort = {
  effort: string;
  description?: string;
};

type LogFn = (message: string) => void;

type CodexModelsResponse = {
  models?: CodexApiModel[];
};

type CodexApiModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  max_input_tokens?: number;
  maxInputTokens?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  input_modalities?: string[];
  default_reasoning_level?: string;
  supported_reasoning_levels?: CodexReasoningEffort[];
};

const DEFAULT_CLIENT_VERSION = "0.136.0";

export class CodexModelRegistry {
  private cachedModels: CodexModelInfo[] | undefined;
  private loadedAt = 0;

  constructor(
    private readonly auth: CodexAuthManager,
    private readonly endpoint: string,
    private readonly log: LogFn
  ) {}

  async getModels(): Promise<CodexModelInfo[]> {
    if (this.cachedModels && Date.now() - this.loadedAt < 5 * 60_000) {
      return this.cachedModels;
    }

    this.cachedModels = await this.fetchRemoteModels();
    this.loadedAt = Date.now();

    return this.cachedModels;
  }

  refresh(): void {
    this.cachedModels = undefined;
    this.loadedAt = 0;
  }

  private async fetchRemoteModels(): Promise<CodexModelInfo[]> {
    const startedAt = Date.now();
    const url = new URL(this.endpoint);
    url.searchParams.set("client_version", DEFAULT_CLIENT_VERSION);

    try {
      const session = await this.auth.getSession();
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${session.accessToken}`,
          ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {})
        }
      });

      if (!response.ok) {
        this.log(`models: Codex API fetch failed; status=${response.status}; durationMs=${Date.now() - startedAt}`);
        return [];
      }

      const body = await response.json() as CodexModelsResponse;
      const models = this.modelsFromApi(body);

      this.log(`models: Codex API loaded ${models.length} visible API model(s); clientVersion=${DEFAULT_CLIENT_VERSION}; durationMs=${Date.now() - startedAt}; ids=${models.map((model) => model.id).join(",") || "none"}`);
      return models;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`models: Codex API fetch failed; error=${message}; durationMs=${Date.now() - startedAt}`);
      return [];
    }
  }

  private modelsFromApi(body: CodexModelsResponse): CodexModelInfo[] {
    return (body.models ?? [])
      .filter((model) => model.slug && model.supported_in_api === true && model.visibility !== "hide")
      .sort((left, right) => (left.priority ?? 9999) - (right.priority ?? 9999))
      .map((model) => ({
        id: model.slug as string,
        name: model.display_name ?? formatModelName(model.slug as string),
        description: model.description,
        priority: model.priority,
        maxInputTokens: numericValue(model.max_input_tokens, model.maxInputTokens, model.context_window),
        maxOutputTokens: numericValue(model.max_output_tokens, model.maxOutputTokens),
        contextWindow: numericValue(model.context_window),
        maxContextWindow: numericValue(model.max_context_window),
        effectiveContextWindowPercent: numericValue(model.effective_context_window_percent),
        inputModalities: stringArray(model.input_modalities),
        defaultReasoningEffort: model.default_reasoning_level,
        supportedReasoningEfforts: normalizeReasoningEfforts(model.supported_reasoning_levels),
        source: "codex-api"
      }));
  }
}

export function toVsCodeModelId(codexModelId: string): string {
  return `${VSCODE_MODEL_ID_PREFIX}${codexModelId}`;
}

export function toCodexModelId(vsCodeModelId: string): string {
  return vsCodeModelId.startsWith(VSCODE_MODEL_ID_PREFIX)
    ? vsCodeModelId.slice(VSCODE_MODEL_ID_PREFIX.length)
    : vsCodeModelId;
}

function formatModelName(id: string): string {
  return id
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") {
        return "GPT";
      }
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function numericValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length ? strings : undefined;
}

function normalizeReasoningEfforts(value: unknown): CodexReasoningEffort[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const efforts = value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const effort = (item as { effort?: unknown }).effort;
    if (typeof effort !== "string" || !effort.trim()) {
      return [];
    }

    const description = (item as { description?: unknown }).description;
    return [{
      effort,
      description: typeof description === "string" ? description : undefined
    }];
  });

  return efforts.length ? efforts : undefined;
}
