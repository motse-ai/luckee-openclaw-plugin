# Luckee OpenClaw Plugin

[English](./README.md) | [中文](./README.zh-CN.md)

An [OpenClaw](https://openclaw.ai) plugin that exposes the **luckee CLI** as an AI-callable tool and chat command. It lets AI assistants query Lingxing data through any OpenClaw-connected channel (Telegram, WhatsApp, Discord, Feishu, Slack, and more).

## Features

- **`luckee_query` tool** — AI agents can call Lingxing queries programmatically.
- **`/luckee` command** — Users can run queries directly from any chat channel.
- **Streaming output** — Real-time progress updates on push-capable channels with editable messages.
- **Per-sender token management** — Tokens are stored securely per user and persisted across restarts.
- **Auto-install** — Automatically installs the `luckee-cli` Python package if not found.
- **Multi-channel support** — Telegram, WhatsApp, Discord, Feishu, Slack, Signal, and many more.

## Prerequisites

- [OpenClaw](https://openclaw.ai) gateway running
- Python 3.8+ (for the `luckee-cli` backend)
- Node.js 18+

## Installation

### 1. Install the luckee CLI

```bash
pip install --upgrade luckee-cli
```

### 2. Register the plugin with OpenClaw

```bash
openclaw plugins add /path/to/luckee-openclaw-plugin
openclaw plugins enable luckee-tool
```

### 3. Configure required settings

```bash
openclaw config set plugins.entries.luckee-tool.config.defaultUrl "<your-api-url>"
openclaw config set plugins.entries.luckee-tool.config.defaultUserId "<your-user-id>"
openclaw config set plugins.entries.luckee-tool.config.defaultLingxingAccount "<account>"
```

Then restart the gateway:

```bash
openclaw gateway restart
```

## Configuration

All settings live under `plugins.entries["luckee-tool"].config` in your OpenClaw config.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `binaryPath` | string | `luckee-cli` | Path to the luckee CLI binary |
| `defaultUrl` | string | — | **Required.** API endpoint URL |
| `defaultUserId` | string | — | **Required.** Default user ID |
| `defaultLingxingAccount` | string | — | **Required.** Lingxing account identifier |
| `defaultLanguage` | string | `CN` | Query language |
| `defaultToken` | string | — | Default API token |
| `tokenStorePath` | string | auto | Path to the persisted token store |
| `defaultTimeout` | number | `90` | Query timeout in seconds |
| `streamFlushMs` | number | `500` | Streaming flush interval in milliseconds |
| `autoInstallCli` | boolean | `true` | Auto-install luckee-cli via pip if not found |
| `pythonPath` | string | auto | Python executable for auto-install |

## Usage

### Chat command

```
/luckee 查一下 asin B0FFGNZ36F 的信息 用skills
```

### Set a token for your session

```
/luckee token sk_your_token_here
```

### Set a token and run a query in one go

```
/luckee token sk_your_token_here 查一下 asin B0FFGNZ36F 的信息
```

### AI tool invocation

AI agents connected to OpenClaw can call the `luckee_query` tool with:

```json
{
  "query": "查一下 asin B0FFGNZ36F 的信息 用skills",
  "token": "sk_optional_override",
  "language": "CN",
  "timeout": 90
}
```

## Security

- Tokens are stored in `~/.openclaw/secrets/luckee-tool/tokens.json` with `0600` permissions.
- Per-sender tokens are keyed by SHA-256 hash of the sender identity.
- Token values are redacted in all log output.
- The plugin enforces `defaultUrl` from config — callers cannot override the API endpoint.

## License

MIT
