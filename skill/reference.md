# Luckee Skill — Reference

## Config Schema

All settings live under `plugins.entries["luckee-tool"].config` in `~/.openclaw/openclaw.json`.

| Key | Type | Default | Required | Description |
|-----|------|---------|----------|-------------|
| `binaryPath` | string | `luckee-cli` | No | Path to the luckee CLI binary |
| `defaultUrl` | string | — | No | Legacy/advanced API endpoint override (normally not needed) |
| `defaultUserId` | string | — | No | Legacy/advanced default user ID (normally not needed) |
| `defaultLanguage` | string | `CN` | No | Query language code |
| `defaultLingxingAccount` | string | — | No | Legacy/advanced Lingxing account identifier (normally not needed) |
| `defaultToken` | string | — | No | Default API authentication token |
| `tokenStorePath` | string | `~/.openclaw/secrets/luckee-tool/tokens.json` | No | Path to the persisted token store file |
| `defaultTimeout` | number | `90` | No | Query timeout in seconds |
| `streamFlushMs` | number | `500` | No | Interval in ms between streaming progress flushes |
| `autoInstallCli` | boolean | `true` | No | Automatically install luckee-cli via pip if binary not found |
| `pythonPath` | string | auto-detected | No | Python executable used for auto-installing luckee-cli |

## Complete openclaw.json Plugin Entry Example

```json
{
  "plugins": {
    "entries": {
      "luckee-tool": {
        "source": "/path/to/luckee-openclaw-plugin/plugin",
        "enabled": true,
        "config": {
          "binaryPath": "luckee-cli",
          "defaultLanguage": "CN",
          "defaultToken": "sk_live_xxxx",
          "defaultTimeout": 90,
          "streamFlushMs": 500,
          "autoInstallCli": true
        }
      }
    }
  }
}
```

## Push-Capable Channels (Streaming Support)

The plugin sends real-time streaming progress updates on channels that support push messaging with editable messages. These channels get live-updating progress indicators during long queries:

- `telegram`
- `whatsapp`
- `discord`
- `irc`
- `googlechat`
- `slack`
- `signal`
- `imessage`
- `feishu`
- `nostr`
- `msteams`
- `mattermost`
- `nextcloud-talk`
- `matrix`
- `bluebubbles`
- `line`
- `zalo`
- `zalouser`
- `synology-chat`
- `tlon`

On Feishu, the plugin uses native card updates via the Feishu Open API (`im/v1/messages/{id}` PATCH) for smoother in-place editing. This is an **optional** feature that only activates when the user has already configured `channels.feishu.appId` and `channels.feishu.appSecret` in OpenClaw. The plugin never prompts for or collects these credentials itself.

## Token Store Format

> This file is auto-managed by OpenClaw. Do not edit it manually.

Stored at `~/.openclaw/secrets/luckee-tool/tokens.json` with `0600` permissions.

```json
{
  "version": 1,
  "defaultToken": "sk_live_xxxx",
  "bySender": {
    "<sha256-of-channel|account|sender>": "sk_sender_token_yyyy"
  }
}
```

- Sender keys are SHA-256 hashes of `channel|accountId|senderId` (e.g., `telegram||12345`).
- The `defaultToken` is used when no sender-specific token exists.
- Tokens set via `/luckee token <token>` are persisted here and survive gateway restarts.
- The file and parent directory are created automatically with restrictive permissions.

## Binary Resolution

The plugin resolves the luckee CLI binary in this order:

1. `config.binaryPath` (if set and non-empty)
2. `luckee-cli`
3. `luckee`

For each candidate, the plugin runs `<binary> --version` and checks:
- Exit code 0, or
- Output contains `usage: luckee` or ` luckee `, plus `--url` and `--user-id` flags

If all candidates fail and `autoInstallCli` is true (default), the plugin attempts:

```bash
<python> -m pip install --upgrade 'luckee-cli>=0.1.2026031307,<0.2.0'
```

Python candidates tried: `config.pythonPath` (if set), then `python3`, `python`, `py`.

After auto-install, the binary probe runs again. Results are cached per configuration for the lifetime of the gateway process.

## Authentication Behavior

- `luckee login` starts browser-based authorization explicitly.
- Running normal `luckee` commands also checks session status and prompts browser authorization automatically when not logged in.
- During support flows, do not ask users for API URL, User ID, or Lingxing account credentials.

## Feishu Card Native Updates (Optional)

> This feature only activates when the user has already configured Feishu credentials in OpenClaw. The plugin never prompts for or collects `appId`/`appSecret` on its own.

When the channel is `feishu` and the plugin has a `messageId` from a previous send, it attempts in-place card updates via:

```
PATCH https://open.feishu.cn/open-apis/im/v1/messages/{messageId}
Authorization: Bearer <tenant_access_token>
Content-Type: application/json

{ "content": "<interactive card JSON>" }
```

The tenant access token is obtained from:

```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
{ "app_id": "<appId>", "app_secret": "<appSecret>" }
```

Token is cached with TTL from the response (default 7200s). Credentials come from `channels.feishu.appId` and `channels.feishu.appSecret` in OpenClaw config.

If the native update fails, the plugin falls back to sending a new message and deleting the old one.

## Error Catalog

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing query.` | Tool called without `query` parameter | Provide a non-empty `query` string |
| `Not logged in` / auth-related error | Local Luckee session is missing or expired | Run `luckee login` (or rerun a normal `luckee` command to trigger auto-login), complete browser authorization, then retry |
| `luckee CLI is required but was not found` | No luckee binary found and auto-install failed | Run `pip install --upgrade 'luckee-cli>=0.1.2026031307,<0.2.0'` manually, or set `binaryPath` |
| `luckee exited with code <N>` | CLI returned non-zero exit | Check stderr in the error message; common causes: invalid token, network timeout, bad query |
| Auth expired during runtime | Login session timed out | Re-run `luckee login` and retry the query |
| `plugin id mismatch (manifest uses "luckee-tool", entry hints "luckee-openclaw-plugin")` | Config key doesn't match the plugin manifest ID | Run `openclaw config unset plugins.entries.luckee-openclaw-plugin` and re-register |
| `auto-install failed: tried python executables` | pip install couldn't find a working Python | Install Python 3.10+ and ensure `python3` is on PATH, or set `pythonPath` |
