---
name: luckee
description: Query product data with Luckee. Use this for `/luckee ...` requests and normal Luckee product lookups.
user-invocable: true
---

# Luckee

Use this skill when the user asks for Luckee product data or invokes `/luckee`.

## Command Handling

Interpret `/luckee` arguments like this:

- Empty input: reply with brief usage help.
- `stop`: call the `luckee_stop` tool.
- `token <token>`: call `luckee_set_token` with the token and confirm it was saved.
- `token <token> <query>`: call `luckee_set_token`, then call `luckee_query` with the remaining query.
- Any other non-empty input: call `luckee_query` with the raw query text.

## Query Rules

- Do not ask the user for `defaultUrl` or `defaultUserId`.
- Prefer returning the Luckee result directly with minimal extra commentary.
- If the tool indicates authentication is needed, surface the auth instructions clearly.
- If the user wants to cancel an in-flight Luckee request, call `luckee_stop`.
