---
name: luckee-skill
description: Install and operate the luckee-tool OpenClaw plugin for querying Lingxing data. Use when the user mentions luckee, Lingxing, ASIN lookup, product data queries, or wants to set up the luckee plugin.
---

# Luckee Skill

## Pre-flight

Before doing anything, check whether the plugin is already installed:

```bash
openclaw plugins list
```

If `luckee-tool` appears and shows as enabled, skip straight to **Usage**. Otherwise, follow **Install** below.

## Install

### 1. Clone the plugin repo

```bash
git clone https://github.com/motse-ai/luckee-openclaw-plugin.git /tmp/luckee-openclaw-plugin
```

### 2. Install dependencies

```bash
cd /tmp/luckee-openclaw-plugin/plugin && npm install
```

### 3. Register with OpenClaw

```bash
openclaw plugins install /tmp/luckee-openclaw-plugin/plugin
```

### 4. Configure required settings

Ask the user for these three values, then set them:

```bash
openclaw config set plugins.entries.luckee-tool.config.defaultUrl "<api-url>"
openclaw config set plugins.entries.luckee-tool.config.defaultUserId "<user-id>"
openclaw config set plugins.entries.luckee-tool.config.defaultLingxingAccount "<account>"
```

### 5. Restart and verify

```bash
openclaw gateway restart
openclaw plugins info luckee-tool
openclaw health
```

Confirm the plugin shows as loaded and the gateway is healthy.

## Usage

### Chat command

```
/luckee <query>
```

Example: `/luckee 查一下 asin B0FFGNZ36F 的信息 用skills`

### Set a token

```
/luckee token <token>
```

Set a token and run a query in one go:

```
/luckee token sk_xxx 查一下 asin B0FFGNZ36F 的信息
```

### AI tool invocation

Call the `luckee_query` tool with:

```json
{
  "query": "查一下 asin B0FFGNZ36F 的信息 用skills",
  "token": "sk_optional_override",
  "language": "CN",
  "timeout": 90
}
```

Only `query` is required. All other fields fall back to plugin config defaults.

## Token Management

- Tokens persist at `~/.openclaw/secrets/luckee-tool/tokens.json` (0600 permissions).
- Per-sender tokens are keyed by SHA-256 hash of `channel|account|sender`.
- A default token can be set via config: `openclaw config set plugins.entries.luckee-tool.config.defaultToken "<token>"`.
- Tokens set via `/luckee token` override the config default for that sender and are persisted across restarts.

## Troubleshooting

### Binary not found

The plugin auto-installs `luckee-cli` via pip when `autoInstallCli` is true (default). If that fails:

```bash
pip install --upgrade 'luckee-cli>=0.1.2026031307,<0.2.0'
openclaw gateway restart
```

Or set the path explicitly:

```bash
openclaw config set plugins.entries.luckee-tool.config.binaryPath "/path/to/luckee-cli"
```

### Missing config keys

If queries fail with "Missing required values", check all three required keys are set:

```bash
openclaw config get plugins.entries.luckee-tool.config.defaultUrl
openclaw config get plugins.entries.luckee-tool.config.defaultUserId
openclaw config get plugins.entries.luckee-tool.config.defaultLingxingAccount
```

### Timeout

Increase the default timeout (seconds):

```bash
openclaw config set plugins.entries.luckee-tool.config.defaultTimeout 180
```

### Plugin ID mismatch warning

If you see "plugin id mismatch (manifest uses luckee-tool, entry hints luckee-openclaw-plugin)":

```bash
openclaw config unset plugins.entries.luckee-openclaw-plugin
openclaw gateway restart
```

## Safety Rules

- **Never** log or display full tokens. Always redact to `sk_x***xx` format.
- All install/config operations are idempotent — safe to re-run.
- Do **not** overwrite unrelated config keys when setting luckee-tool config.
- The plugin enforces `defaultUrl` from config — callers cannot override the API endpoint.

## Reference

For detailed config schema, channel list, token store format, and error catalog, see [reference.md](reference.md).
