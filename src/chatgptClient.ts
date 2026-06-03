import * as vscode from "vscode";
import { CodexAuthManager } from "./auth";

type ResponsesInputItem = {
  type: "message";
  role: "system" | "user" | "assistant";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
} | {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
} | {
  type: "function_call_output";
  call_id: string;
  output: string;
};

type ResponsesTool = {
  type: "function";
  name: string;
  description: string;
  parameters: object;
};

type PendingToolCall = {
  callId?: string;
  name?: string;
  arguments: string;
};

export class ChatGptCodexClient {
  constructor(
    private readonly auth: CodexAuthManager,
    private readonly endpoint: string,
    private readonly getInstructions: () => string,
    private readonly output: vscode.OutputChannel
  ) {}

  async streamText(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    defaultReasoningEffort?: string
  ): Promise<void> {
    const startedAt = Date.now();
    const requestId = createRequestId();
    const session = await this.auth.getSession();
    const abort = new AbortController();
    const abortSubscription = token.onCancellationRequested(() => abort.abort());
    const input = toResponsesInput(messages);
    const translated = summarizeInput(input);
    const instructions = this.getInstructions();
    const tools = toResponsesTools(options.tools ?? []);
    const reasoningEffort = getReasoningEffort(options.modelOptions, defaultReasoningEffort);
    const pendingToolCalls = new Map<string, PendingToolCall>();

    this.log(`request ${requestId}: translated ${messages.length} VS Code message(s) to ${input.length} Codex item(s); chars=${translated.chars}; roles=${translated.roles}`);
    this.log(`request ${requestId}: sending model=${modelId}; reasoningEffort=${reasoningEffort ?? "default"}; instructionsChars=${instructions.length}; tools=${tools.length}; toolMode=${options.toolMode}; account=${session.accountId ? "present" : "unknown"}`);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal: abort.signal,
        headers: {
          "accept": "text/event-stream",
          "authorization": `Bearer ${session.accessToken}`,
          "content-type": "application/json",
          ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {})
        },
        body: JSON.stringify({
          model: modelId,
          instructions,
          input,
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
          ...(tools.length ? { tools, tool_choice: toResponsesToolChoice(options.toolMode) } : {}),
          stream: true,
          store: false
        })
      });

      this.log(`request ${requestId}: Codex API responded; status=${response.status}; durationMs=${Date.now() - startedAt}`);
      if (!response.ok) {
        throw new Error(`Codex backend returned HTTP ${response.status}: ${await safeErrorPreview(response)}`);
      }
      if (!response.body) {
        throw new Error("Codex backend returned an empty response body.");
      }

      let eventCount = 0;
      let textChars = 0;
      let toolCallCount = 0;
      let sawText = false;
      for await (const event of parseSse(response.body)) {
        if (token.isCancellationRequested) {
          this.log(`request ${requestId}: cancelled after ${eventCount} event(s); textChars=${textChars}; durationMs=${Date.now() - startedAt}`);
          break;
        }
        eventCount += 1;
        for (const text of extractTextDeltas(event)) {
          textChars += text.length;
          if (!sawText && text.length > 0) {
            sawText = true;
            this.log(`request ${requestId}: first text delta received; event=${eventCount}`);
          }
          progress.report(new vscode.LanguageModelTextPart(text));
        }
        for (const toolCall of extractToolCalls(event, pendingToolCalls)) {
          toolCallCount += 1;
          this.log(`request ${requestId}: tool call emitted; name=${toolCall.name}; callId=${toolCall.callId}; event=${eventCount}`);
          progress.report(toolCall);
        }
      }
      if (!token.isCancellationRequested) {
        this.log(`request ${requestId}: stream complete; events=${eventCount}; textChars=${textChars}; toolCalls=${toolCallCount}; durationMs=${Date.now() - startedAt}`);
      }
    } catch (error) {
      if (!token.isCancellationRequested) {
        this.log(`request ${requestId}: failed; durationMs=${Date.now() - startedAt}; error=${redact(String(error))}`);
        throw error;
      }
    } finally {
      abortSubscription.dispose();
    }
  }

  private log(message: string): void {
    this.output.appendLine(`${new Date().toISOString()} ${message}`);
  }
}

function toResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesInputItem[] {
  return messages.flatMap((message) => {
    const items: ResponsesInputItem[] = [];
    const textParts: string[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        flushTextMessage(items, message.role, textParts);
        items.push({
          type: "function_call",
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {})
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        flushTextMessage(items, message.role, textParts);
        items.push({
          type: "function_call_output",
          call_id: part.callId,
          output: toolResultText(part)
        });
        continue;
      }

      const text = textFromPart(part);
      if (text?.trim()) {
        textParts.push(text);
      }
    }

    flushTextMessage(items, message.role, textParts);
    return items;
  });
}

function flushTextMessage(items: ResponsesInputItem[], roleValue: unknown, textParts: string[]): void {
  const text = textParts.join("\n\n");
  textParts.length = 0;
  if (!text.trim()) {
    return;
  }

  const role = toResponsesRole(roleValue);
  items.push({
    type: "message",
    role,
    content: [{
      type: role === "assistant" ? "output_text" : "input_text",
      text
    }]
  });
}

function toResponsesRole(role: unknown): "system" | "user" | "assistant" {
  const normalized = typeof role === "string" ? role.toLowerCase() : String(role).toLowerCase();
  if (normalized.includes("system")) {
    return "system";
  }
  if (normalized.includes("assistant")) {
    return "assistant";
  }
  return "user";
}

function summarizeInput(input: ResponsesInputItem[]): { chars: number; roles: string } {
  const counts = new Map<string, number>();
  let chars = 0;

  for (const item of input) {
    if (item.type === "message") {
      counts.set(item.role, (counts.get(item.role) ?? 0) + 1);
      chars += item.content.reduce((total, part) => total + part.text.length, 0);
      continue;
    }
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    chars += item.type === "function_call" ? item.arguments.length : item.output.length;
  }

  const roles = [...counts.entries()]
    .map(([role, count]) => `${role}:${count}`)
    .join(",");

  return {
    chars,
    roles: roles || "none"
  };
}

function toResponsesTools(tools: readonly vscode.LanguageModelChatTool[]): ResponsesTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? {
      type: "object",
      properties: {}
    }
  }));
}

function toResponsesToolChoice(mode: vscode.LanguageModelChatToolMode): "auto" | "required" {
  return mode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}

function getReasoningEffort(
  modelOptions: vscode.ProvideLanguageModelChatResponseOptions["modelOptions"],
  defaultReasoningEffort: string | undefined
): string | undefined {
  const optionValue = stringOption(
    modelOptions?.reasoningEffort,
    modelOptions?.thinkingEffort,
    modelOptions?.reasoning_effort,
    modelOptions?.thinking_effort
  );

  return optionValue ?? defaultReasoningEffort;
}

function stringOption(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function toolResultText(part: vscode.LanguageModelToolResultPart): string {
  return part.content
    .map((content) => textFromToolResultContent(content))
    .filter((value): value is string => Boolean(value?.trim()))
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
}

function textFromToolResultContent(content: unknown): string | undefined {
  if (content instanceof vscode.LanguageModelTextPart) {
    return content.value;
  }

  if (typeof content === "string") {
    return content;
  }

  return undefined;
}

function textFromPart(part: vscode.LanguageModelChatRequestMessage["content"][number]): string | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  return undefined;
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        yield JSON.parse(data) as unknown;
      } catch {
        continue;
      }
    }
  }
}

function extractTextDeltas(event: unknown): string[] {
  const value = event as {
    type?: string;
    delta?: unknown;
    text?: unknown;
  };

  if (typeof value.delta === "string" && isOutputTextDeltaEvent(value.type)) {
    return [value.delta];
  }
  if (typeof value.text === "string" && isOutputTextDeltaEvent(value.type)) {
    return [value.text];
  }

  return [];
}

function isOutputTextDeltaEvent(type: string | undefined): boolean {
  return type === "response.output_text.delta";
}

function extractToolCalls(
  event: unknown,
  pending: Map<string, PendingToolCall>
): vscode.LanguageModelToolCallPart[] {
  const value = event as {
    type?: string;
    item?: unknown;
    delta?: unknown;
    arguments?: unknown;
    item_id?: unknown;
    output_index?: unknown;
  };

  const item = asToolCallItem(value.item);
  if (item) {
    const key = item.id ?? item.call_id;
    if (key) {
      pending.set(key, {
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments ?? ""
      });
    }
  }

  if (value.type === "response.function_call_arguments.delta") {
    const key = stringValue(value.item_id) ?? stringValue(value.output_index);
    if (key && typeof value.delta === "string") {
      const current = pending.get(key) ?? { arguments: "" };
      current.arguments += value.delta;
      pending.set(key, current);
    }
    return [];
  }

  if (value.type === "response.function_call_arguments.done") {
    const key = stringValue(value.item_id) ?? stringValue(value.output_index);
    if (key) {
      const current = pending.get(key);
      if (current && typeof value.arguments === "string") {
        current.arguments = value.arguments;
      }
    }
    return [];
  }

  if ((value.type === "response.output_item.done" || value.type === "response.output_item.added") && item?.call_id && item.name) {
    const key = item.id ?? item.call_id;
    const current = pending.get(key) ?? {
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments ?? ""
    };
    current.callId = current.callId ?? item.call_id;
    current.name = current.name ?? item.name;
    if (value.type === "response.output_item.done" && typeof item.arguments === "string") {
      current.arguments = item.arguments;
    }

    if (value.type === "response.output_item.added" && !current.arguments) {
      pending.set(key, current);
      return [];
    }

    pending.delete(key);
    return [new vscode.LanguageModelToolCallPart(
      current.callId ?? item.call_id,
      current.name ?? item.name,
      parseToolArguments(current.arguments)
    )];
  }

  return [];
}

function asToolCallItem(value: unknown): {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
} | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const item = value as {
    id?: unknown;
    type?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
  };

  if (item.type !== "function_call") {
    return undefined;
  }

  return {
    id: stringValue(item.id),
    type: "function_call",
    call_id: stringValue(item.call_id),
    name: stringValue(item.name),
    arguments: stringValue(item.arguments)
  };
}

function parseToolArguments(value: string | undefined): object {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as object : { value: parsed };
  } catch {
    return { value };
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

async function safeErrorPreview(response: Response): Promise<string> {
  const text = await response.text();
  return redact(text.slice(0, 400));
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/g, "\"access_token\":\"[redacted]\"")
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, "\"refresh_token\":\"[redacted]\"");
}

function createRequestId(): string {
  return Math.random().toString(36).slice(2, 8);
}
