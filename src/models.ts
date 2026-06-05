import { CodexAuthManager } from "./auth";
import { formatConnectionError, redactUrl } from "./connectionErrors";

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
const MODEL_FETCH_TIMEOUT_MS = 10_000;
const MAX_MODEL_FETCH_ATTEMPTS = 3;

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

    const models = await this.fetchRemoteModels();
    if (models.length) {
      this.cachedModels = models;
      this.loadedAt = Date.now();
    }

    return models.length ? models : this.cachedModels ?? [];
  }

  async reload(): Promise<CodexModelInfo[]> {
    this.refresh();
    return this.getModels();
  }

  refresh(): void {
    this.cachedModels = undefined;
    this.loadedAt = 0;
  }

  private async fetchRemoteModels(): Promise<CodexModelInfo[]> {
    for (let attempt = 1; attempt <= MAX_MODEL_FETCH_ATTEMPTS; attempt += 1) {
      const models = await this.fetchRemoteModelsOnce(attempt);
      if (models) {
        return models;
      }

      if (attempt < MAX_MODEL_FETCH_ATTEMPTS) {
        await sleep(attempt * 500);
      }
    }

    this.log(`models: Codex API fetch gave up after ${MAX_MODEL_FETCH_ATTEMPTS} attempt(s)`);
    return [];
  }

  private async fetchRemoteModelsOnce(attempt: number): Promise<CodexModelInfo[] | undefined> {
    const startedAt = Date.now();
    const url = new URL(this.endpoint);
    url.searchParams.set("client_version", DEFAULT_CLIENT_VERSION);
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort(new Error(`Timed out waiting ${MODEL_FETCH_TIMEOUT_MS}ms for Codex models.`));
    }, MODEL_FETCH_TIMEOUT_MS);

    try {
      const session = await this.auth.getSession();
      const response = await fetch(url, {
        signal: abort.signal,
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${session.accessToken}`,
          ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {})
        }
      });

      if (!response.ok) {
        this.log(`models: Codex API fetch attempt ${attempt}/${MAX_MODEL_FETCH_ATTEMPTS} failed; status=${response.status}; statusText=${response.statusText}; durationMs=${Date.now() - startedAt}; url=${redactUrl(url)}`);
        return undefined;
      }

      const body = await response.json() as CodexModelsResponse;
      const models = this.modelsFromApi(body);

      this.log(`models: Codex API loaded ${models.length} visible API model(s); attempt=${attempt}/${MAX_MODEL_FETCH_ATTEMPTS}; clientVersion=${DEFAULT_CLIENT_VERSION}; durationMs=${Date.now() - startedAt}; ids=${models.map((model) => model.id).join(",") || "none"}`);
      return models;
    } catch (error) {
      this.log(`models: Codex API fetch attempt ${attempt}/${MAX_MODEL_FETCH_ATTEMPTS} failed; error=${formatConnectionError(error)}; durationMs=${Date.now() - startedAt}; url=${redactUrl(url)}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
