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

Before installing, **ask the user for confirmation**: explain that the plugin will be fetched from its GitHub repository and registered with OpenClaw.

### 1. Register the plugin with OpenClaw

```bash
openclaw plugins install https://github.com/motse-ai/luckee-openclaw-plugin
```

This single command fetches the plugin and installs its dependencies. Do **not** run `git clone` or `npm install` manually.

### 2. Authenticate with Luckee

Run:

```bash
luckee login
```

This command opens a browser auth page. Ask the user to complete authorization in the web page, then continue in terminal once login finishes.
Running regular `luckee` commands also checks login status and will prompt the same web authorization flow if the user is not logged in.

**No browser access (remote machine, headless server, SSH session, etc.):** If the environment cannot open a browser — for example, a remote server, a container, or an SSH session — the `luckee login` command will still print an authorization URL to stdout. You **must** copy the full URL from the terminal output and present it to the user so they can open it in their own browser. Do not attempt to launch a browser in these environments.

### 3. Restart and verify

```bash
openclaw gateway restart
openclaw plugins info luckee-tool
openclaw health
```

Confirm the plugin shows as loaded and the gateway is healthy. Do not ask the user for API URL, User ID, or Lingxing account details.

## Usage

### Chat command

```
/luckee <query>
```

Example: `/luckee 查一下 asin B0DPJMTH4N 的信息 用skills`

### Set a token

```
/luckee token <token>
```

Set a token and run a query in one go:

```
/luckee token sk_xxx 查一下 asin B0DPJMTH4N 的信息
```

### AI tool invocation

Call the `luckee_query` tool with:

```json
{
  "query": "查一下 asin B0DPJMTH4N 的信息 用skills",
  "token": "sk_optional_override",
  "language": "CN",
  "timeout": 90
}
```

Only `query` is required. Auth context is handled by CLI/session state (via `luckee login` or the auto-login prompt when running `luckee` commands).

## Token Management

- Tokens are managed securely by OpenClaw and persisted across gateway restarts.
- Set a per-user token via `/luckee token <token>` (overrides the default for that sender).
- Set a default token via config: `openclaw config set plugins.entries.luckee-tool.config.defaultToken "<token>"`.
- See [reference.md](reference.md) for advanced token store details.

## Troubleshooting

### Binary not found

The plugin auto-installs `luckee-cli` via pip when `autoInstallCli` is true (default). If that fails:

```bash
python -m pip install --upgrade \
  --index-url https://test.pypi.org/simple/ \
  --extra-index-url https://pypi.org/simple \
  luckee-cli
openclaw gateway restart
```

Or set the path explicitly:

```bash
openclaw config set plugins.entries.luckee-tool.config.binaryPath "/path/to/luckee-cli"
```

### Not logged in / auth expired

If queries fail with auth/login errors:

**Option 1 — Direct terminal login (preferred when you have terminal access):**
```bash
luckee login
```
Complete authorization in the browser, then retry the query. If running on a remote machine or headless environment where a browser cannot be opened, copy the full authorization URL printed in the terminal output and present it to the user to open manually.

**Option 2 — Set token via chat (when OAuth can't work, e.g. running inside gateway):**
```
/luckee token <your_token>
```

**Option 3 — Set token via config:**
```bash
openclaw config set plugins.entries.luckee-tool.config.defaultToken "<your_token>"
```

Note: The `/luckee login` chat command has a 15-second timeout. If the OAuth callback server cannot start properly in the gateway environment (empty `redirect_uri`), it will time out gracefully and suggest using a token instead.

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
- Never request API URL, User ID, or Lingxing account credentials from users during normal setup/query flows.

## Reference

For detailed config schema, channel list, token store format, and error catalog, see [reference.md](reference.md).
