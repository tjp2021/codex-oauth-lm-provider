import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CODEX_CLIENT_ID, TOKEN_ENDPOINT } from "./constants";

type JwtPayload = {
  exp?: number;
  "https://api.openai.com/auth.chatgpt_account_id"?: string;
  chatgpt_account_id?: string;
};

type CodexAuthFile = {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
};

export type CodexSession = {
  accessToken: string;
  accountId?: string;
};

type LogFn = (message: string) => void;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class CodexAuthManager {
  constructor(
    private readonly authFilePath: string,
    private readonly log: LogFn = () => {}
  ) {}

  async getSession(): Promise<CodexSession> {
    const startedAt = Date.now();
    this.log(`auth: reading Codex auth file at ${this.authFilePath}`);
    const auth = await this.readAuthFile();
    const tokens = auth.tokens;

    if (!tokens?.access_token || !tokens.refresh_token) {
      throw new AuthError(`No Codex OAuth tokens found in ${this.authFilePath}. Run "codex login" first.`);
    }

    if (this.isExpiredOrNearExpiry(tokens.access_token)) {
      this.log("auth: access token missing expiry or near expiry; refreshing");
      return this.refresh(auth);
    }

    const accountId = this.extractAccountId(auth);
    this.log(`auth: using cached access token; account=${accountId ? "present" : "unknown"}; durationMs=${Date.now() - startedAt}`);
    return {
      accessToken: tokens.access_token,
      accountId
    };
  }

  private async refresh(auth: CodexAuthFile): Promise<CodexSession> {
    const startedAt = Date.now();
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken) {
      throw new AuthError("Codex auth file does not contain a refresh token.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      this.log(`auth: refresh failed; status=${response.status}; durationMs=${Date.now() - startedAt}`);
      throw new AuthError(`Codex OAuth refresh failed with HTTP ${response.status}.`);
    }

    const refreshed = await response.json() as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };

    if (!refreshed.access_token) {
      throw new AuthError("Codex OAuth refresh response did not include an access token.");
    }

    auth.tokens = {
      ...auth.tokens,
      id_token: refreshed.id_token ?? auth.tokens?.id_token,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? auth.tokens?.refresh_token
    };
    auth.last_refresh = new Date().toISOString();

    await fs.writeFile(this.authFilePath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });

    this.log(`auth: refresh succeeded; account=${this.extractAccountId(auth) ? "present" : "unknown"}; durationMs=${Date.now() - startedAt}`);
    return {
      accessToken: refreshed.access_token,
      accountId: this.extractAccountId(auth)
    };
  }

  private async readAuthFile(): Promise<CodexAuthFile> {
    try {
      return JSON.parse(await fs.readFile(this.authFilePath, "utf8")) as CodexAuthFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AuthError(`Codex auth file not found at ${this.authFilePath}. Run "codex login" first.`);
      }
      throw error;
    }
  }

  private extractAccountId(auth: CodexAuthFile): string | undefined {
    const explicit = auth.tokens?.account_id;
    if (explicit) {
      return explicit;
    }

    const idPayload = parseJwtPayload(auth.tokens?.id_token);
    const accessPayload = parseJwtPayload(auth.tokens?.access_token);

    return idPayload?.["https://api.openai.com/auth.chatgpt_account_id"]
      ?? accessPayload?.["https://api.openai.com/auth.chatgpt_account_id"]
      ?? idPayload?.chatgpt_account_id
      ?? accessPayload?.chatgpt_account_id;
  }

  private isExpiredOrNearExpiry(token: string): boolean {
    const payload = parseJwtPayload(token);
    if (!payload?.exp) {
      return true;
    }

    const refreshAt = payload.exp * 1000 - 60_000;
    return Date.now() >= refreshAt;
  }
}

export function resolveHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseJwtPayload(token: string | undefined): JwtPayload | undefined {
  if (!token) {
    return undefined;
  }

  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    return JSON.parse(json) as JwtPayload;
  } catch {
    return undefined;
  }
}
