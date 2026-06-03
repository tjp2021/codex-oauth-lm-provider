# Codex OAuth LM Provider

Experimental VS Code `LanguageModelChatProvider` that reuses the local Codex CLI ChatGPT OAuth login from `~/.codex/auth.json`.

This is an MVP bridge, not a stable product surface. The ChatGPT/Codex backend is private-ish and can change without notice.

## What Works

- Reads the existing Codex CLI auth file.
- Refreshes the access token with `https://auth.openai.com/oauth/token`.
- Registers `openai-codex-oauth` as a VS Code language model provider.
- Auto-provisions visible API-supported models from `https://chatgpt.com/backend-api/codex/models`.
- Exposes VS Code model IDs with a `codex-oauth.` prefix to avoid collisions with other providers.
- Exposes API-supported thinking effort levels as selectable model variants.
- Sources model context window metadata from the live Codex models API.
- Does not read or write the Codex model cache.
- Streams text deltas from `https://chatgpt.com/backend-api/codex/responses`.
- Supports VS Code tool calling.

## Not Yet

- Running the Codex device flow inside VS Code.
- WebSocket transport.
- Full Codex request metadata parity.

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

Run `Codex OAuth LM Provider: Check Auth` to validate that the auth file is present and refreshable. The extension never logs access or refresh tokens.
