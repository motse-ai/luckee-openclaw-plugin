---
name: openclaw-ops
description: Operates and troubleshoots OpenClaw gateway, health, config, and plugins. Use when the user asks to restart/check OpenClaw, diagnose gateway or channel issues, update openclaw.json, or manage plugin warnings and allowlists.
---

# OpenClaw Ops

## Quick Start

For any OpenClaw operational request, run this sequence first:

1. `openclaw health`
2. If unhealthy or asked to restart: `openclaw gateway restart`
3. Re-check: `openclaw health`
4. If still failing: `openclaw gateway status` then `openclaw doctor --fix`

## Gateway Commands

- Start foreground gateway: `openclaw gateway`
- Managed service lifecycle:
  - `openclaw gateway install`
  - `openclaw gateway start`
  - `openclaw gateway stop`
  - `openclaw gateway restart`
  - `openclaw gateway uninstall`
- Health and diagnostics:
  - `openclaw health`
  - `openclaw gateway status`
  - `openclaw logs`
  - `openclaw doctor` / `openclaw doctor --fix`

## Configuration Workflow

When user asks to change settings:

1. Prefer one-liners for targeted edits:
   - `openclaw config get <path>`
   - `openclaw config set <path> <value>`
   - `openclaw config unset <path>`
2. Use `openclaw configure` or `openclaw onboard` for broader setup.
3. Re-run `openclaw health` after changes.

Notes:
- Config file is `~/.openclaw/openclaw.json`.
- Most settings hot-reload; gateway infrastructure changes can require restart.

## Luckee Plugin Operations

This repository is the `luckee-tool` OpenClaw plugin. Key operations:

- Enable: `openclaw plugins enable luckee-tool`
- Disable: `openclaw plugins disable luckee-tool`
- Check status: `openclaw plugins info luckee-tool`

Required config keys (under `plugins.entries.luckee-tool.config`):
- `defaultUrl` — API endpoint
- `defaultUserId` — user ID
- `defaultLingxingAccount` — Lingxing account

Set via:
```
openclaw config set plugins.entries.luckee-tool.config.defaultUrl "https://..."
openclaw config set plugins.entries.luckee-tool.config.defaultUserId "user123"
openclaw config set plugins.entries.luckee-tool.config.defaultLingxingAccount "account_name"
```

The luckee CLI (`luckee-cli`) is a Python package. Install or upgrade:
```
pip install --upgrade luckee-cli
```

If the plugin reports binary not found, set the binary path explicitly:
```
openclaw config set plugins.entries.luckee-tool.config.binaryPath "/path/to/luckee-cli"
```

## General Plugin Operations

Use:

- `openclaw plugins list`
- `openclaw plugins info <id>`
- `openclaw plugins enable <id>`
- `openclaw plugins disable <id>`

If warnings mention duplicate plugin IDs:

1. Identify duplicate plugin source paths in output.
2. Keep a single intended source where possible.
3. Recommend explicit trust controls via `plugins.allow`.

Security:
- Plugins run in-process with gateway privileges.
- Treat plugin install/enable as trusted-code operations.

## Response Style For Ops Tasks

- Return concrete command outcomes, not just intent.
- If command output is long, summarize key lines and implications.
- After restart/fix tasks, always include current health state.
