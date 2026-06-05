export async function safeResponsePreview(response: Response): Promise<string> {
  const text = await response.text();
  return redactSensitive(text.slice(0, 400));
}

export function formatConnectionError(error: unknown, leadingMessages: string[] = []): string {
  return redactSensitive([...leadingMessages, ...errorChain(error)].join("; caused by: "));
}

export function redactUrl(url: URL): string {
  const redacted = new URL(url);
  for (const key of redacted.searchParams.keys()) {
    if (/token|key|secret/i.test(key)) {
      redacted.searchParams.set(key, "[redacted]");
    }
  }
  return redacted.toString();
}

function errorChain(error: unknown): string[] {
  const parts: string[] = [];
  let current: unknown = error;

  while (current) {
    if (current instanceof Error) {
      parts.push(errorSummary(current));
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    parts.push(String(current));
    break;
  }

  return parts.length ? parts : ["Unknown error"];
}

function errorSummary(error: Error): string {
  const details = [
    `name=${error.name}`,
    error.message ? `message=${error.message}` : undefined,
    stringProperty(error, "code") ? `code=${stringProperty(error, "code")}` : undefined,
    stringProperty(error, "errno") ? `errno=${stringProperty(error, "errno")}` : undefined,
    stringProperty(error, "syscall") ? `syscall=${stringProperty(error, "syscall")}` : undefined,
    stringProperty(error, "hostname") ? `hostname=${stringProperty(error, "hostname")}` : undefined
  ].filter(Boolean);

  return details.join(" ");
}

function stringProperty(value: object, key: string): string | undefined {
  const property = (value as Record<string, unknown>)[key];
  if (typeof property === "string" || typeof property === "number") {
    return String(property);
  }
  return undefined;
}

function redactSensitive(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/g, "\"access_token\":\"[redacted]\"")
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, "\"refresh_token\":\"[redacted]\"");
}
