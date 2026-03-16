import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";

type LuckeeConfig = {
  binaryPath?: string;
  defaultUrl?: string;
  defaultUserId?: string;
  defaultLanguage?: string;
  defaultLingxingAccount?: string;
  defaultToken?: string;
  tokenStorePath?: string;
  defaultTimeout?: number;
  streamFlushMs?: number;
  autoInstallCli?: boolean;
  pythonPath?: string;
};

const LUCKEE_CLI_PIP_SPEC = "luckee-cli>=0.1.2026031307,<0.2.0";

const CLI_INSTALL_GUIDE =
  "luckee CLI is required but was not found.\n" +
  `Install it with: python -m pip install --upgrade '${LUCKEE_CLI_PIP_SPEC}'\n` +
  "Then restart OpenClaw. If your executable name differs, set plugins.entries[\"luckee-tool\"].config.binaryPath.";

const PUSH_CAPABLE_CHANNELS = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
  "feishu",
  "nostr",
  "msteams",
  "mattermost",
  "nextcloud-talk",
  "matrix",
  "bluebubbles",
  "line",
  "zalo",
  "zalouser",
  "synology-chat",
  "tlon",
]);

let feishuTokenCache: { token: string; expireAt: number } | null = null;
const resolvedBinaryByConfig = new Map<string, string>();
const attemptedAutoInstallByConfig = new Set<string>();
const tokenBySender = new Map<string, string>();
const persistedTokenBySenderHash = new Map<string, string>();
let persistedDefaultToken: string | undefined;
let tokenStoreLoaded = false;
let tokenStoreLoadPromise: Promise<void> | null = null;

type LuckeeTokenStore = {
  version: 1;
  defaultToken?: string;
  bySender: Record<string, string>;
};

function hashSenderKey(senderKey: string): string {
  return createHash("sha256").update(senderKey).digest("hex");
}

function redactToken(token?: string): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}***${token.slice(-2)}`;
}

function safePreview(text: string, maxLen = 200): string {
  const t = String(text || "").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

function logLuckeeInvocation(api: any, origin: "tool" | "command", info: Record<string, any>): void {
  try {
    api.logger?.info?.(`[luckee] ${origin} invocation: ${JSON.stringify(info)}`);
  } catch {
    api.logger?.info?.(`[luckee] ${origin} invocation`);
  }
}

function redactCliArgs(args: string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "--token" && i + 1 < out.length) {
      out[i + 1] = redactToken(out[i + 1]) || "***";
      i += 1;
    }
  }
  return out;
}

function getTokenStorePath(cfg: LuckeeConfig): string {
  if (cfg.tokenStorePath && cfg.tokenStorePath.trim()) {
    return cfg.tokenStorePath.trim();
  }
  const baseDir =
    process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  return path.join(baseDir, "secrets", "luckee-tool", "tokens.json");
}

async function writeTokenStore(cfg: LuckeeConfig): Promise<void> {
  const storePath = getTokenStorePath(cfg);
  const hashedBySender = Object.fromEntries(persistedTokenBySenderHash.entries());
  const payload: LuckeeTokenStore = {
    version: 1,
    defaultToken: persistedDefaultToken,
    bySender: hashedBySender,
  };
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf8");
  if (process.platform !== "win32") {
    // Best effort: owner read/write only on POSIX.
    await fs.chmod(storePath, 0o600).catch(() => undefined);
  }
}

async function ensureTokenStoreLoaded(api: any, cfg: LuckeeConfig): Promise<void> {
  if (tokenStoreLoaded) return;
  if (tokenStoreLoadPromise) return tokenStoreLoadPromise;
  tokenStoreLoadPromise = (async () => {
    const storePath = getTokenStorePath(cfg);
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LuckeeTokenStore>;
      const bySender = parsed?.bySender && typeof parsed.bySender === "object"
        ? parsed.bySender
        : {};
      for (const [k, v] of Object.entries(bySender)) {
        if (typeof v === "string" && v.trim()) {
          const normalizedKey = k.includes("|") ? hashSenderKey(k) : k;
          persistedTokenBySenderHash.set(normalizedKey, v.trim());
        }
      }
      if (typeof parsed?.defaultToken === "string" && parsed.defaultToken.trim()) {
        persistedDefaultToken = parsed.defaultToken.trim();
      }
      api.logger?.info?.(
        `[luckee] loaded token store: path=${storePath} senderTokens=${persistedTokenBySenderHash.size} hasDefault=${Boolean(
          persistedDefaultToken
        )}`
      );
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        api.logger?.warn?.(
          `[luckee] failed to load token store: ${String(err?.message || err)}`
        );
      }
    } finally {
      tokenStoreLoaded = true;
      tokenStoreLoadPromise = null;
    }
  })();
  return tokenStoreLoadPromise;
}

function getSenderKey(ctx: any): string {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const sender = String(ctx.from || ctx.senderId || ctx.to || "").trim();
  const account = String(ctx.accountId || "").trim();
  return `${channel}|${account}|${sender}`;
}

function parseTokenDirective(text: string): { token: string; query?: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(?:use\s+)?token\s+(\S+)(?:\s+(.+))?$/i);
  if (!m) return null;
  const token = String(m[1] || "").trim();
  const query = String(m[2] || "").trim();
  if (!token) return null;
  return { token, query: query || undefined };
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code === 0) {
        const out = stdout.trim();
        const err = stderr.trim();
        resolve(out || err || "(luckee completed with empty output)");
        return;
      }
      reject(
        new Error(
          `luckee exited with code ${code}\n` +
            `${stderr.trim() || stdout.trim() || "no output"}`
        )
      );
    });
  });
}

async function runCommandDetailed(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function splitChunks(text: string, maxLen = 900): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function normalizeWrappedUrls(text: string): string {
  if (!text) return text;
  // Some render paths may insert hard line-breaks inside long URLs.
  // Re-join newline boundaries when both sides look URL-safe.
  let out = text;
  const wrappedUrlBoundary =
    /((?:https?:\/\/)[^\s\n]+)\n(?=[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%])/g;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(wrappedUrlBoundary, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

function withProgressFooter(text: string, tick: number): string {
  const dots = ".".repeat((tick % 3) + 1);
  return `${text}\n\n---\n⏳ Still loading${dots}`;
}

function withDoneFooter(text: string): string {
  return `${text}\n\n---\n✅ Completed`;
}

function resolveLuckeeInvocation(api: any, params: any): {
  args: string[];
  cfg: LuckeeConfig;
} {
  const cfg: LuckeeConfig =
    api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};

  const url = cfg.defaultUrl;
  const userId = params.userId || cfg.defaultUserId;
  const language = params.language || cfg.defaultLanguage || "CN";
  const lingxingAccount = params.lingxingAccount || cfg.defaultLingxingAccount;
  const token = params.token || cfg.defaultToken || persistedDefaultToken;
  const timeout = String(params.timeout || cfg.defaultTimeout || 90);

  const query = String(params.query ?? "").trim();
  if (!query) {
    throw new Error("Missing query.");
  }

  if (params.url && String(params.url).trim()) {
    api.logger?.warn?.("[luckee] Ignored caller-provided url; enforced defaultUrl from plugin config.");
  }

  const args: string[] = [];
  if (url) args.push("--url", url);
  if (userId) args.push("--user-id", userId);
  args.push("--language", language);
  if (lingxingAccount) args.push("--config", JSON.stringify({ lingxing_account: lingxingAccount }));
  args.push("--query", query, "--timeout", timeout);
  if (token) args.push("--token", String(token));

  return { cfg, args };
}

async function executeLuckee(api: any, params: any): Promise<string> {
  const runtimeCfg: LuckeeConfig =
    api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
  await ensureTokenStoreLoaded(api, runtimeCfg);
  if (params?.token && String(params.token).trim()) {
    persistedDefaultToken = String(params.token).trim();
    await writeTokenStore(runtimeCfg);
    api.logger?.info?.("[luckee] persisted default token from tool invocation.");
  }
  const { cfg, args } = resolveLuckeeInvocation(api, params);
  logLuckeeInvocation(api, "tool", {
    query: safePreview(String(params.query ?? "")),
    hasToken: Boolean(params.token || cfg.defaultToken || persistedDefaultToken),
    token: redactToken(String(params.token || cfg.defaultToken || persistedDefaultToken || "")),
    userId: String(params.userId || cfg.defaultUserId || ""),
    language: String(params.language || cfg.defaultLanguage || "CN"),
    timeout: Number(params.timeout || cfg.defaultTimeout || 90),
    url: String(cfg.defaultUrl || ""),
  });
  const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
  api.logger?.info?.(`[luckee] tool resolved binary: ${binaryPath}`);
  api.logger?.info?.(
    `[luckee] tool cli args: ${JSON.stringify(redactCliArgs(args))}`
  );
  return runCommand(binaryPath, args);
}

function getLuckeeBinaryCandidates(cfg: LuckeeConfig): string[] {
  const raw = [cfg.binaryPath?.trim(), "luckee-cli", "luckee"].filter(
    (v): v is string => Boolean(v)
  );
  return [...new Set(raw)];
}

function isLuckeeProbeSuccess(candidate: string, result: { code: number; stdout: string; stderr: string }): boolean {
  if (result.code === 0) return true;
  const out = `${result.stdout}\n${result.stderr}`.toLowerCase();
  // Some "luckee" binaries do not support --version and exit non-zero while printing usage/help.
  if (!out) return false;
  const mentionsLuckee = out.includes("usage: luckee") || out.includes(" luckee ");
  const hasCliFlags = out.includes("--url") && out.includes("--user-id");
  return mentionsLuckee && hasCliFlags && candidate.includes("luckee");
}

async function resolveLuckeeBinaryOrThrow(
  api: any,
  cfg: LuckeeConfig
): Promise<string> {
  const candidates = getLuckeeBinaryCandidates(cfg);
  const cacheKey = candidates.join("|");
  const cached = resolvedBinaryByConfig.get(cacheKey);
  if (cached) return cached;

  const probeErrors: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await runCommandDetailed(candidate, ["--version"]);
      if (isLuckeeProbeSuccess(candidate, result)) {
        resolvedBinaryByConfig.set(cacheKey, candidate);
        if (candidate !== candidates[0]) {
          api.logger?.info?.(
            `[luckee] using fallback binary "${candidate}" (primary "${candidates[0]}" not available).`
          );
        }
        return candidate;
      }
      probeErrors.push(
        `${candidate}: exit=${result.code} ${(
          result.stderr.trim() ||
          result.stdout.trim() ||
          "no output"
        ).slice(0, 180)}`
      );
    } catch (err: any) {
      probeErrors.push(`${candidate}: ${String(err?.message || err)}`);
    }
  }

  const allowAutoInstall = cfg.autoInstallCli !== false;
  const alreadyAttemptedAutoInstall = attemptedAutoInstallByConfig.has(cacheKey);
  if (allowAutoInstall && !alreadyAttemptedAutoInstall) {
    attemptedAutoInstallByConfig.add(cacheKey);
    const installResult = await attemptLuckeeCliInstall(api, cfg);
    if (installResult.ok) {
      for (const candidate of candidates) {
        try {
          const result = await runCommandDetailed(candidate, ["--version"]);
          if (isLuckeeProbeSuccess(candidate, result)) {
            resolvedBinaryByConfig.set(cacheKey, candidate);
            api.logger?.info?.(`[luckee] auto-installed CLI and resolved binary "${candidate}".`);
            return candidate;
          }
        } catch {
          // continue
        }
      }
    } else {
      probeErrors.push(`auto-install failed: ${installResult.reason}`);
    }
  }

  throw new Error(
    `${CLI_INSTALL_GUIDE}\n` +
      `Checked binaries: ${candidates.join(", ")}\n` +
      (probeErrors.length ? `Probe details: ${probeErrors.join(" | ")}` : "")
  );
}

async function attemptLuckeeCliInstall(
  api: any,
  cfg: LuckeeConfig
): Promise<{ ok: boolean; reason?: string }> {
  const pythonCandidates = cfg.pythonPath
    ? [cfg.pythonPath]
    : ["python3", "python", "py"];
  const pipArgs = ["-m", "pip", "install", "--upgrade", LUCKEE_CLI_PIP_SPEC];

  for (const py of pythonCandidates) {
    try {
      api.logger?.info?.(`[luckee] attempting auto-install via: ${py} ${pipArgs.join(" ")}`);
      const result = await runCommandDetailed(py, pipArgs);
      if (result.code === 0) {
        return { ok: true };
      }
    } catch (err: any) {
      api.logger?.warn?.(`[luckee] auto-install probe failed for ${py}: ${String(err?.message || err)}`);
    }
  }

  return {
    ok: false,
    reason: `tried python executables: ${pythonCandidates.join(", ")}`,
  };
}

function runCommandStreaming(
  command: string,
  args: string[],
  onFlush: (chunk: string) => Promise<void>,
  flushEveryMs = 2500,
  onTick?: () => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";

    const flush = async () => {
      const text = pending.trim();
      if (!text) return;
      pending = "";
      const chunks = splitChunks(text);
      for (const chunk of chunks) {
        await onFlush(chunk);
      }
    };

    let queue = Promise.resolve();
    const queueFlush = () => {
      queue = queue
        .then(async () => {
          await flush();
          if (onTick) await onTick();
        })
        .catch(() => undefined);
    };

    const timer = setInterval(queueFlush, flushEveryMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pending += text;
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      pending += text;
    });

    child.on("error", (err) => {
      clearInterval(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(timer);
      queue = queue
        .then(async () => {
          await flush();
          if (onTick) await onTick();
        })
        .then(() => {
          if (code === 0) {
            const out = stdout.trim();
            const err = stderr.trim();
            resolve(out || err || "(luckee completed with empty output)");
            return;
          }
          reject(
            new Error(
              `luckee exited with code ${code}\n` +
                `${stderr.trim() || stdout.trim() || "no output"}`
            )
          );
        })
        .catch(reject);
    });
  });
}

async function sendProgressMessage(ctx: any, text: string): Promise<boolean> {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = String(ctx.to || ctx.from || ctx.senderId || "").trim();
  if (!channel || !target || !PUSH_CAPABLE_CHANNELS.has(channel)) return false;

  const args = [
    "message",
    "send",
    "--channel",
    channel,
    "--target",
    target,
    "--message",
    text,
  ];
  if (ctx.accountId) args.push("--account", String(ctx.accountId));
  if (ctx.messageThreadId != null) {
    args.push("--thread-id", String(ctx.messageThreadId));
  }

  try {
    await runCommand("openclaw", args);
    return true;
  } catch {
    return false;
  }
}

function parseTrailingJsonObject(text: string): Record<string, any> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    // fall through
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybeObj = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(maybeObj);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      // fall through
    }
  }

  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t || (!t.startsWith("{") && !t.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractMessageId(payload: any): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const direct = payload.messageId || payload.message_id || payload.id;
  if (direct != null) return String(direct);

  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value && typeof value === "object") {
      const nested = extractMessageId(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractMessageIdFromRaw(text: string): string | undefined {
  const patterns = [
    /"message_id"\s*:\s*"([^"]+)"/,
    /"messageId"\s*:\s*"([^"]+)"/,
    /"msg_id"\s*:\s*"([^"]+)"/,
    /"messageId"\s*:\s*'([^']+)'/,
    /"message_id"\s*:\s*'([^']+)'/,
    /"id"\s*:\s*"([^"]+)"/,
    /\bom_[A-Za-z0-9_-]+\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
    if (m?.[0] && m[0].startsWith("om_")) return m[0];
  }
  return undefined;
}

function buildMessageArgs(ctx: any, text: string): string[] {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = String(ctx.to || ctx.from || ctx.senderId || "").trim();
  const args = [
    "--channel",
    channel,
    "--target",
    target,
    "--message",
    text,
  ];
  if (ctx.accountId) args.push("--account", String(ctx.accountId));
  if (ctx.messageThreadId != null) args.push("--thread-id", String(ctx.messageThreadId));
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFeishuCard(text: string): Record<string, any> {
  const markdownSafeText = text.replace(
    /(https?:\/\/[^\s<>"`]+)/g,
    (_m, url: string) => `[Open URL](${url})`
  );
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**Luckee 流式输出**\n\n${markdownSafeText}`,
        },
      ],
    },
  };
}

function resolveFeishuCreds(api: any): { appId?: string; appSecret?: string } {
  const feishu = api?.config?.channels?.feishu ?? {};
  return {
    appId: feishu.appId,
    appSecret: feishu.appSecret,
  };
}

async function getFeishuTenantToken(api: any): Promise<string | null> {
  const now = Date.now();
  if (feishuTokenCache && feishuTokenCache.expireAt > now + 10_000) {
    return feishuTokenCache.token;
  }

  const { appId, appSecret } = resolveFeishuCreds(api);
  if (!appId || !appSecret) return null;

  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  if (!res.ok) return null;
  const data: any = await res.json();
  if (!data || data.code !== 0 || !data.tenant_access_token) return null;

  const ttlSec = Number(data.expire || 7200);
  feishuTokenCache = {
    token: String(data.tenant_access_token),
    expireAt: now + ttlSec * 1000,
  };
  return feishuTokenCache.token;
}

async function updateFeishuCardNative(
  api: any,
  messageId: string,
  text: string
): Promise<boolean> {
  try {
    const token = await getFeishuTenantToken(api);
    if (!token) return false;

    const card = buildFeishuCard(text);
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      }
    );
    const bodyText = await res.text();
    let data: any = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = null;
    }
    const ok = res.ok && data?.code === 0;
    if (!ok) {
      api.logger?.warn?.(
        `[luckee] feishu native patch failed status=${res.status} body=${bodyText.slice(0, 500)}`
      );
    }
    return ok;
  } catch {
    return false;
  }
}

async function deleteMessageBestEffort(ctx: any, messageId?: string): Promise<void> {
  if (!messageId) return;
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = String(ctx.to || ctx.from || ctx.senderId || "").trim();
  if (!channel || !target) return;

  const args = [
    "message",
    "delete",
    "--channel",
    channel,
    "--target",
    target,
    "--message-id",
    messageId,
  ];
  if (ctx.accountId) args.push("--account", String(ctx.accountId));

  for (let i = 0; i < 3; i++) {
    try {
      await runCommand("openclaw", args);
      return;
    } catch {
      if (i < 2) await sleep(300);
    }
  }
  // best effort only
}

async function sendProgressMessageEditable(
  api: any,
  ctx: any,
  text: string,
  prevMessageId?: string
): Promise<{ ok: boolean; messageId?: string; edited: boolean }> {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = String(ctx.to || ctx.from || ctx.senderId || "").trim();
  if (!channel || !target || !PUSH_CAPABLE_CHANNELS.has(channel)) {
    return { ok: false, edited: false };
  }

  if (channel === "feishu" && prevMessageId) {
    const ok = await updateFeishuCardNative(api, prevMessageId, text);
    api.logger?.info?.(
      `[luckee] feishu update card: ${ok ? "ok" : "failed"} messageId=${prevMessageId}`
    );
    if (ok) return { ok: true, messageId: prevMessageId, edited: true };
  }

  if (channel !== "feishu" && prevMessageId) {
    const editArgs = [
      "message",
      "edit",
      ...buildMessageArgs(ctx, text),
      "--message-id",
      prevMessageId,
      "--json",
    ];
    const result = await runCommandDetailed("openclaw", editArgs);
    if (result.code === 0) return { ok: true, messageId: prevMessageId, edited: true };
  }

  const sendArgs = ["message", "send", ...buildMessageArgs(ctx, text), "--json"];
  const result = await runCommandDetailed("openclaw", sendArgs);
  if (result.code !== 0) return { ok: false, edited: false };

  const payload =
    parseTrailingJsonObject(result.stdout) || parseTrailingJsonObject(result.stderr);
  const messageId =
    extractMessageId(payload) ||
    extractMessageIdFromRaw(result.stdout) ||
    extractMessageIdFromRaw(result.stderr);
  api.logger?.info?.(
    `[luckee] send progress: channel=${channel} code=${result.code} messageId=${messageId || "none"}`
  );
  if (!messageId && channel === "feishu") {
    api.logger?.warn?.(
      `[luckee] feishu send had no messageId; stdout=${result.stdout.slice(0, 300)} stderr=${result.stderr.slice(0, 300)}`
    );
  }
  if (prevMessageId && messageId && messageId !== prevMessageId) {
    await deleteMessageBestEffort(ctx, prevMessageId);
  }
  return { ok: true, messageId, edited: false };
}

export default function register(api: any) {
  api.registerTool(
    {
      name: "luckee_query",
      description: "Run a query through luckee CLI.",
      parameters: Type.Object({
        query: Type.String(),
        token: Type.Optional(Type.String()),
        userId: Type.Optional(Type.String()),
        language: Type.Optional(Type.String()),
        lingxingAccount: Type.Optional(Type.String()),
        timeout: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: any) {
        try {
          const output = await executeLuckee(api, params);
          api.logger?.info?.(
            `[luckee] tool success: query="${safePreview(String(params.query ?? ""))}" outputChars=${output.length}`
          );
          return { content: [{ type: "text", text: output }] };
        } catch (err: any) {
          api.logger?.error?.(
            `[luckee] tool failed: query="${safePreview(String(params.query ?? ""))}" error=${String(
              err?.message || err
            )}`
          );
          throw err;
        }
      },
    }
  );

  api.registerCommand({
    name: "luckee",
    description: "Run luckee query and return result directly.",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: any) => {
      try {
        const rawArgs = (ctx.args || "").trim();
        if (!rawArgs) {
          logLuckeeInvocation(api, "command", {
            action: "usage",
            channel: String(ctx.channelId || ctx.channel || ""),
            sender: String(ctx.from || ctx.senderId || ""),
          });
          return {
            text:
              "Usage:\n" +
              "/luckee <query>\n" +
              "/luckee token <token>\n" +
              "/luckee token <token> <query>\n\n" +
              "Example: /luckee token sk_xxx 查一下 asin B0FFGNZ36F 的信息 用skills",
          };
        }
        const senderKey = getSenderKey(ctx);
        const cfg: LuckeeConfig =
          api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
        await ensureTokenStoreLoaded(api, cfg);
        const tokenDirective = parseTokenDirective(rawArgs);
        let inlineToken: string | undefined;
        let query = rawArgs;
        if (tokenDirective) {
          tokenBySender.set(senderKey, tokenDirective.token);
          persistedTokenBySenderHash.set(hashSenderKey(senderKey), tokenDirective.token);
          persistedDefaultToken = tokenDirective.token;
          await writeTokenStore(cfg);
          inlineToken = tokenDirective.token;
          logLuckeeInvocation(api, "command", {
            action: tokenDirective.query ? "token-set-and-run" : "token-set",
            channel: String(ctx.channelId || ctx.channel || ""),
            sender: String(ctx.from || ctx.senderId || ""),
            token: redactToken(tokenDirective.token),
            query: safePreview(tokenDirective.query || ""),
          });
          if (!tokenDirective.query) {
            return {
              text: "Token saved for this chat. Now send `/luckee <query>`.",
            };
          }
          query = tokenDirective.query;
        }

        let streamed = false;
        let progressMessageId: string | undefined;
        let accumulated = "";
        let loadingTick = 0;
        const flushEveryMs = Math.max(300, Number(cfg.streamFlushMs ?? 1000));
        const storedToken =
          tokenBySender.get(senderKey) || persistedTokenBySenderHash.get(hashSenderKey(senderKey));
        const effectiveToken = inlineToken || storedToken || cfg.defaultToken || persistedDefaultToken;
        logLuckeeInvocation(api, "command", {
          action: "run",
          channel: String(ctx.channelId || ctx.channel || ""),
          sender: String(ctx.from || ctx.senderId || ""),
          query: safePreview(query),
          hasInlineToken: Boolean(inlineToken),
          hasStoredToken: Boolean(storedToken),
          hasPersistedDefaultToken: Boolean(persistedDefaultToken),
          token: redactToken(effectiveToken || ""),
          userId: String(cfg.defaultUserId || ""),
          url: String(cfg.defaultUrl || ""),
          flushEveryMs,
        });
        const { args } = resolveLuckeeInvocation(api, {
          query,
          token: effectiveToken,
        });
        const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
        api.logger?.info?.(`[luckee] command resolved binary: ${binaryPath}`);
        api.logger?.info?.(
          `[luckee] command cli args: ${JSON.stringify(redactCliArgs(args))}`
        );

        const pushProgress = async (chunk?: string) => {
          if (chunk) {
            accumulated = accumulated ? `${accumulated}${chunk}` : chunk;
            if (accumulated.length > 3500) {
              accumulated = `...(truncated old output)\n${accumulated.slice(-3200)}`;
            }
          }
          if (!accumulated) return;

          const progressText = withProgressFooter(
            normalizeWrappedUrls(accumulated),
            loadingTick
          );
          loadingTick += 1;

          const edited = await sendProgressMessageEditable(
            api,
            ctx,
            progressText,
            progressMessageId
          );
          if (edited.ok) {
            progressMessageId = edited.messageId || progressMessageId;
            streamed = true;
            return;
          }

          const sent = await sendProgressMessage(ctx, progressText);
          if (sent) streamed = true;
        };

        const output = await runCommandStreaming(
          binaryPath,
          args,
          async (chunk) => pushProgress(chunk),
          flushEveryMs,
          async () => pushProgress()
        );

        if (streamed) {
          if (progressMessageId) {
            const finalText = withDoneFooter(
              normalizeWrappedUrls(output.length > 3500 ? output.slice(-3500) : output)
            );
            await sendProgressMessageEditable(api, ctx, finalText, progressMessageId);
          }
          api.logger?.info?.(
            `[luckee] command success(streamed): query="${safePreview(query)}" outputChars=${output.length}`
          );
          return { text: "luckee 执行完成，流式结果已分段推送。" };
        }
        api.logger?.info?.(
          `[luckee] command success: query="${safePreview(query)}" outputChars=${output.length}`
        );
        return { text: output };
      } catch (err: any) {
        const raw = String(err?.message || err || "Unknown error");
        const message = raw.length > 1200 ? `${raw.slice(0, 1200)}...` : raw;
        api.logger?.error?.(`[luckee] command failed: ${raw}`);
        return {
          text:
            `Luckee command failed.\n${message}\n\n` +
            "If this is a config issue, check plugin config or re-run: luckee login",
        };
      }
    },
  });
}
