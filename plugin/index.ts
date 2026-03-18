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

  defaultToken?: string;
  tokenStorePath?: string;
  defaultTimeout?: number;
  streamFlushMs?: number;
  autoInstallCli?: boolean;
  pythonPath?: string;
};

const LUCKEE_CLI_PIP_SPEC = "luckee-cli";

const CLI_INSTALL_GUIDE =
  "luckee CLI is required but was not found.\n" +
  "Install it with: python -m pip install --upgrade " +
  "--index-url https://test.pypi.org/simple/ " +
  "luckee-cli\n" +
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
type TrackedProcess = {
  kill: () => void;
  query: string;
};

type AuthWaitSession = TrackedProcess & {
  id: string;
  authUrl?: string | null;
  messageId?: string;
  startedAt: number;
  origin: "tool" | "command";
};

type FeishuCardOptions = {
  stopButtonDisabled?: boolean;
  stopButtonText?: string;
};

type ActiveFeishuProgressCard = {
  messageId: string;
  text: string;
};

type StreamingRaceResult =
  | { kind: "done"; output: string }
  | { kind: "error"; error: any }
  | { kind: "auth"; sessionId: string };

type InteractiveLuckeeResult =
  | { kind: "done"; output: string; usedPush: boolean }
  | { kind: "auth-pending"; message: string; usedPush: boolean };

const activeProcesses = new Map<string, TrackedProcess>();
const authWaitSessions = new Map<string, AuthWaitSession>();
const activeFeishuProgressCards = new Map<string, ActiveFeishuProgressCard>();

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

function extractAuthUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/(https?:\/\/\S*auth\S*)/i);
  return m ? m[1] : null;
}

function detectLoginRequired(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("starting oauth login") ||
    lower.includes("no valid token provided") ||
    lower.includes("open this url to continue login") ||
    lower.includes("no saved credentials") ||
    lower.includes("opening browser for login") ||
    lower.includes("if the browser did not open") ||
    lower.includes("copy this url")
  );
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

function buildLoginRequiredMessage(authUrl?: string | null): string {
  return (
    "🔐 **需要登录**\n\n" +
    "Luckee 检测到当前未登录或 token 已失效。\n\n" +
    (authUrl ? `授权链接:\n${authUrl}\n\n` : "") +
    "请通过以下方式之一进行认证：\n\n" +
    "**方式一：** 在终端运行 `luckee login` 完成浏览器授权\n\n" +
    "**方式二：** 使用 token\n```\n/luckee token <your_token>\n```\n\n" +
    "**方式三：** 配置默认 token\n```\nopenclaw config set plugins.entries.luckee-tool.config.defaultToken \"<your_token>\"\n```"
  );
}

function buildAuthWaitInProgressMessage(authUrl?: string | null): string {
  return (
    `${buildLoginRequiredMessage(authUrl)}\n\n` +
    "认证仍在后台等待中。完成授权后重新发送请求，或发送 `/luckee stop` 取消当前登录等待。"
  );
}

function createAuthWaitSession(
  query: string,
  kill: () => void,
  authUrl: string | null | undefined,
  messageId: string | undefined,
  origin: "tool" | "command"
): AuthWaitSession {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kill,
    query,
    authUrl,
    messageId,
    startedAt: Date.now(),
    origin,
  };
}

function replaceAuthWaitSession(processKey: string, session: AuthWaitSession): void {
  const prev = authWaitSessions.get(processKey);
  if (prev && prev.id !== session.id) {
    try {
      prev.kill();
    } catch {
      // Best effort only: replaced sessions should stop polling.
    }
  }
  authWaitSessions.set(processKey, session);
}

function withProgressFooter(text: string, tick: number): string {
  const dots = ".".repeat((tick % 3) + 1);
  return `${text}\n\n---\n⏳ Still loading${dots}`;
}

function withDoneFooter(text: string): string {
  return `${text}\n\n---\n✅ Completed`;
}

function withStoppedFooter(text: string): string {
  return `${text}\n\n---\n⏹️ Stopped`;
}

function stripStatusFooter(text: string): string {
  return String(text || "").replace(
    /\n\n---\n(?:⏳ Still loading\.{1,3}|✅ Completed|⏹️ Stopped)\s*$/s,
    ""
  );
}

function rememberActiveFeishuProgressCard(
  processKey: string,
  messageId: string | undefined,
  text: string
): void {
  if (!processKey || !messageId) return;
  activeFeishuProgressCards.set(processKey, { messageId, text });
}

function forgetActiveFeishuProgressCard(processKey: string, messageId?: string): void {
  const current = activeFeishuProgressCards.get(processKey);
  if (!current) return;
  if (messageId && current.messageId !== messageId) return;
  activeFeishuProgressCards.delete(processKey);
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
  args.push("--query", query, "--timeout", timeout);
  if (token) args.push("--token", String(token));

  return { cfg, args };
}

async function executeLuckee(api: any, params: any): Promise<string> {
  const runtimeCfg: LuckeeConfig =
    api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
  await ensureTokenStoreLoaded(api, runtimeCfg);
  const persistProvidedToken = params?.persistProvidedToken !== false;
  if (persistProvidedToken && params?.token && String(params.token).trim()) {
    persistedDefaultToken = String(params.token).trim();
    await writeTokenStore(runtimeCfg);
    api.logger?.info?.(
      `[luckee] persisted default token from ${(params?.origin ?? "tool")} invocation.`
    );
  }
  const { cfg, args } = resolveLuckeeInvocation(api, params);
  const origin = params?.origin === "command" ? "command" : "tool";
  logLuckeeInvocation(api, origin, {
    query: safePreview(String(params.query ?? "")),
    hasToken: Boolean(params.token || cfg.defaultToken || persistedDefaultToken),
    token: redactToken(String(params.token || cfg.defaultToken || persistedDefaultToken || "")),
    userId: String(params.userId || cfg.defaultUserId || ""),
    language: String(params.language || cfg.defaultLanguage || "CN"),
    timeout: Number(params.timeout || cfg.defaultTimeout || 90),
    url: String(cfg.defaultUrl || ""),
  });
  const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
  api.logger?.info?.(`[luckee] ${origin} resolved binary: ${binaryPath}`);
  api.logger?.info?.(
    `[luckee] ${origin} cli args: ${JSON.stringify(redactCliArgs(args))}`
  );
  return runCommand(binaryPath, args);
}

function getLuckeeBinaryCandidates(cfg: LuckeeConfig): string[] {
  const raw = [cfg.binaryPath?.trim(), "luckee", "luckee-cli"].filter(
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

  // PATH-based probe failed; check common pip script directories
  const scriptDirs = await getPipScriptsDirs(cfg);
  for (const dir of scriptDirs) {
    for (const name of ["luckee", "luckee-cli"]) {
      const fullPath = path.join(dir, name);
      if (candidates.includes(fullPath)) continue;
      try {
        const result = await runCommandDetailed(fullPath, ["--version"]);
        if (isLuckeeProbeSuccess(fullPath, result)) {
          resolvedBinaryByConfig.set(cacheKey, fullPath);
          api.logger?.info?.(
            `[luckee] found existing binary in pip scripts dir: ${fullPath}`
          );
          return fullPath;
        }
      } catch {
        // continue
      }
    }
  }

  const allowAutoInstall = cfg.autoInstallCli !== false;
  const alreadyAttemptedAutoInstall = attemptedAutoInstallByConfig.has(cacheKey);
  if (allowAutoInstall && !alreadyAttemptedAutoInstall) {
    attemptedAutoInstallByConfig.add(cacheKey);
    const installResult = await attemptLuckeeCliInstall(api, cfg);
    if (installResult.ok) {
      // Re-probe PATH-based candidates first
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
      // PATH-based probe failed; scan pip script directories
      const scriptDirs = await getPipScriptsDirs(cfg);
      api.logger?.info?.(`[luckee] scanning pip script dirs: ${JSON.stringify(scriptDirs)}`);
      for (const dir of scriptDirs) {
        for (const name of ["luckee", "luckee-cli"]) {
          const fullPath = path.join(dir, name);
          try {
            const result = await runCommandDetailed(fullPath, ["--version"]);
            if (isLuckeeProbeSuccess(fullPath, result)) {
              resolvedBinaryByConfig.set(cacheKey, fullPath);
              api.logger?.info?.(`[luckee] found binary in pip scripts dir: ${fullPath}`);
              return fullPath;
            }
          } catch {
            // continue
          }
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

async function getPipScriptsDirs(cfg: LuckeeConfig): Promise<string[]> {
  const pythonCandidates = cfg.pythonPath
    ? [cfg.pythonPath]
    : ["python3", "python", "py"];
  const dirs: string[] = [];

  for (const py of pythonCandidates) {
    for (const snippet of [
      "import sysconfig; print(sysconfig.get_path('scripts', sysconfig.get_preferred_scheme('user')))",
      "import sysconfig; print(sysconfig.get_path('scripts'))",
    ]) {
      try {
        const result = await runCommandDetailed(py, ["-c", snippet]);
        if (result.code === 0 && result.stdout.trim()) {
          dirs.push(result.stdout.trim());
        }
      } catch {
        // continue
      }
    }
    break;
  }

  dirs.push(path.join(os.homedir(), ".local", "bin"));
  return [...new Set(dirs)];
}

async function attemptLuckeeCliInstall(
  api: any,
  cfg: LuckeeConfig
): Promise<{ ok: boolean; reason?: string }> {
  const pythonCandidates = cfg.pythonPath
    ? [cfg.pythonPath]
    : ["python3", "python", "py"];
  const pipArgs = [
    "-m", "pip", "install", "--upgrade",
    "--index-url", "https://test.pypi.org/simple/",
    "--extra-index-url", "https://pypi.org/simple",
    LUCKEE_CLI_PIP_SPEC,
  ];

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
  onTick?: () => Promise<void>,
  abortHandle?: { kill: () => void }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (abortHandle) {
      abortHandle.kill = () => {
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      };
    }
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
  const target = resolveMessageTarget(ctx);
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

function resolveMessageTarget(ctx: any): string {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  if (channel === "feishu") {
    return String(
      ctx.chatId || ctx.chat_id || ctx.to || ctx.from || ctx.senderId || ""
    ).trim();
  }
  return String(ctx.to || ctx.from || ctx.senderId || "").trim();
}

function buildMessageArgs(ctx: any, text: string): string[] {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = resolveMessageTarget(ctx);
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

function buildFeishuCard(text: string, options: FeishuCardOptions = {}): Record<string, any> {
  const markdownSafeText = text.replace(
    /(https?:\/\/[^\s<>"`]+)/g,
    (_m, url: string) => `[Open URL](${url})`
  );
  const stopButtonDisabled = Boolean(options.stopButtonDisabled);
  const stopButtonText = options.stopButtonText || "Stop Current Query";
  const stopButton: Record<string, any> = {
    tag: "button",
    element_id: "stop_luckee",
    margin: "8px 0 0 0",
    type: stopButtonDisabled ? "default" : "danger_filled",
    size: "small",
    width: "fill",
    disabled: stopButtonDisabled,
    text: {
      tag: "plain_text",
      content: stopButtonText,
    },
  };
  if (!stopButtonDisabled) {
    stopButton.behaviors = [
      {
        type: "callback",
        value: {
          action: "luckee_stop",
          command: "/luckee stop",
          text: "/luckee stop",
        },
      },
    ];
  }
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Luckee 流式输出",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdownSafeText,
        },
        {
          tag: "hr",
        },
        stopButton,
      ],
    },
  };
}

function summarizeFeishuCard(card: Record<string, any>): string {
  const elements = Array.isArray(card?.body?.elements) ? card.body.elements : [];
  const buttons = elements.filter((el: any) => el?.tag === "button");
  return JSON.stringify({
    schema: card?.schema,
    tags: elements.map((el: any) => String(el?.tag || "unknown")),
    buttonCount: buttons.length,
    buttons: buttons.map((el: any) => ({
      element_id: el?.element_id,
      type: el?.type,
      size: el?.size,
      width: el?.width,
      text: el?.text?.content,
      behaviors: Array.isArray(el?.behaviors) ? el.behaviors.map((b: any) => b?.type) : [],
      callbackValue: el?.behaviors?.[0]?.value,
    })),
  });
}

function stripFeishuPrefix(id: string): string {
  return id.startsWith("feishu:") ? id.slice(7) : id;
}

function resolveFeishuReceiveId(ctx: any): { receiveId: string; receiveIdType: string } | null {
  const rawTo = String(ctx.to || "").trim();
  const rawFrom = String(ctx.from || ctx.senderId || "").trim();
  const chatId = String(ctx.chatId || ctx.chat_id || "").trim();

  const candidates = [chatId, rawTo, rawFrom]
    .map((v) => stripFeishuPrefix(v))
    .filter(Boolean);

  for (const id of candidates) {
    if (id.startsWith("oc_")) return { receiveId: id, receiveIdType: "chat_id" };
  }
  for (const id of candidates) {
    if (id.startsWith("ou_")) return { receiveId: id, receiveIdType: "open_id" };
    if (id.startsWith("on_")) return { receiveId: id, receiveIdType: "union_id" };
  }
  if (candidates.length > 0) return { receiveId: candidates[0], receiveIdType: "chat_id" };
  return null;
}

async function sendFeishuCardNative(
  api: any,
  ctx: any,
  text: string,
  options: FeishuCardOptions = {}
): Promise<{ ok: boolean; messageId?: string }> {
  try {
    const token = await getFeishuTenantToken(api);
    if (!token) {
      api.logger?.warn?.("[luckee] feishu card send: no tenant token available");
      return { ok: false };
    }

    const resolved = resolveFeishuReceiveId(ctx);
    if (!resolved) {
      api.logger?.warn?.(
        `[luckee] feishu card send: cannot resolve receiveId from ctx ` +
        `(to=${ctx.to || ""} from=${ctx.from || ""} chatId=${ctx.chatId || ctx.chat_id || ""} senderId=${ctx.senderId || ""})`
      );
      return { ok: false };
    }

    const card = buildFeishuCard(text, options);
    const cardJson = JSON.stringify(card);
    api.logger?.info?.(
      `[luckee] feishu card send payload summary=${summarizeFeishuCard(card)}`
    );
    api.logger?.info?.(
      `[luckee] feishu card send payload json=${safePreview(cardJson, 2500)}`
    );

    const threadId = ctx.messageThreadId != null
      ? String(ctx.messageThreadId).trim()
      : "";

    if (threadId) {
      try {
        const res = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(threadId)}/reply`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              msg_type: "interactive",
              content: cardJson,
            }),
          }
        );
        const bodyText = await res.text();
        let data: any = null;
        try { data = bodyText ? JSON.parse(bodyText) : null; } catch { data = null; }
        if (res.ok && data?.code === 0 && data?.data?.message_id) {
          api.logger?.info?.(
            `[luckee] feishu card reply sent messageId=${data.data.message_id} body=${safePreview(bodyText || "", 1000)}`
          );
          return { ok: true, messageId: data.data.message_id };
        }
        api.logger?.warn?.(
          `[luckee] feishu card reply failed status=${res.status} body=${(bodyText || "").slice(0, 500)}`
        );
      } catch (err: any) {
        api.logger?.warn?.(
          `[luckee] feishu card reply error: ${String(err?.message || err)}`
        );
      }
    }

    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${resolved.receiveIdType}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: resolved.receiveId,
          msg_type: "interactive",
          content: cardJson,
        }),
      }
    );
    const bodyText = await res.text();
    let data: any = null;
    try { data = bodyText ? JSON.parse(bodyText) : null; } catch { data = null; }
    const ok = res.ok && data?.code === 0;
    const messageId = data?.data?.message_id;
    if (!ok) {
      api.logger?.warn?.(
        `[luckee] feishu card send failed status=${res.status} body=${(bodyText || "").slice(0, 500)}`
      );
    } else {
      api.logger?.info?.(
        `[luckee] feishu card send ok messageId=${messageId} body=${safePreview(bodyText || "", 1000)}`
      );
    }
    return { ok, messageId };
  } catch (err: any) {
    api.logger?.warn?.(
      `[luckee] feishu card send error: ${String(err?.message || err)}`
    );
    return { ok: false };
  }
}

async function resolveFeishuCreds(
  api: any
): Promise<{ appId?: string; appSecret?: string; source?: string }> {
  const channels = api?.config?.channels ?? {};

  const clean = (v: any): string | undefined => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return undefined;
    if (s === "__OPENCLAW_REDACTED__" || s === "REDACTED") return undefined;
    return s;
  };

  const feishu = channels?.feishu ?? {};
  const accounts = feishu?.accounts ?? {};
  const defaultAccountId = String(feishu?.defaultAccount || "default");
  const defaultAccount = accounts?.[defaultAccountId] ?? accounts?.default;
  const firstAccount = Object.values(accounts).find((entry: any) => entry && typeof entry === "object") as any;

  const candidates = [
    {
      source: "channels.feishu",
      appId: clean(feishu?.appId),
      appSecret: clean(feishu?.appSecret),
    },
    {
      source: `channels.feishu.accounts.${defaultAccountId}`,
      appId: clean(defaultAccount?.appId),
      appSecret: clean(defaultAccount?.appSecret),
    },
    {
      source: "channels.feishu.accounts.first",
      appId: clean(firstAccount?.appId),
      appSecret: clean(firstAccount?.appSecret),
    },
    {
      source: "channels.entries.feishu",
      appId: clean(channels?.entries?.feishu?.appId),
      appSecret: clean(channels?.entries?.feishu?.appSecret),
    },
    {
      source: "channels.entries.feishu.config",
      appId: clean(channels?.entries?.feishu?.config?.appId),
      appSecret: clean(channels?.entries?.feishu?.config?.appSecret),
    },
  ];

  for (const c of candidates) {
    if (c.appId && c.appSecret) return c;
  }

  const configPath =
    process.env.OPENCLAW_CONFIG_PATH ||
    process.env.OPENCLAW_CONFIG ||
    path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const fileFeishu = parsed?.channels?.feishu ?? {};
    const fileAccounts = fileFeishu?.accounts ?? {};
    const fileDefaultAccountId = String(fileFeishu?.defaultAccount || "default");
    const fileDefaultAccount =
      fileAccounts?.[fileDefaultAccountId] ?? fileAccounts?.default;
    const fileFirstAccount = Object.values(fileAccounts).find(
      (entry: any) => entry && typeof entry === "object"
    ) as any;

    const fileCandidates = [
      {
        source: `file:${configPath}:channels.feishu`,
        appId: clean(fileFeishu?.appId),
        appSecret: clean(fileFeishu?.appSecret),
      },
      {
        source: `file:${configPath}:channels.feishu.accounts.${fileDefaultAccountId}`,
        appId: clean(fileDefaultAccount?.appId),
        appSecret: clean(fileDefaultAccount?.appSecret),
      },
      {
        source: `file:${configPath}:channels.feishu.accounts.first`,
        appId: clean(fileFirstAccount?.appId),
        appSecret: clean(fileFirstAccount?.appSecret),
      },
    ];
    for (const c of fileCandidates) {
      if (c.appId && c.appSecret) {
        api.logger?.info?.(`[luckee] feishu credentials loaded from ${c.source}`);
        return c;
      }
    }
  } catch (err: any) {
    api.logger?.warn?.(
      `[luckee] failed reading feishu credentials from config file ${configPath}: ${String(err?.message || err)}`
    );
  }

  api.logger?.warn?.("[luckee] feishu credentials not found in channel config");
  return {};
}

async function getFeishuTenantToken(api: any): Promise<string | null> {
  const now = Date.now();
  if (feishuTokenCache && feishuTokenCache.expireAt > now + 10_000) {
    return feishuTokenCache.token;
  }

  const { appId, appSecret, source } = await resolveFeishuCreds(api);
  if (!appId || !appSecret) return null;

  try {
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      }
    );
    if (!res.ok) {
      api.logger?.warn?.(
        `[luckee] feishu tenant token: HTTP ${res.status} from token endpoint`
      );
      return null;
    }
    const data: any = await res.json();
    if (!data || data.code !== 0 || !data.tenant_access_token) {
      api.logger?.warn?.(
        `[luckee] feishu tenant token: API error code=${data?.code} msg=${data?.msg || "unknown"}`
      );
      return null;
    }

    const ttlSec = Number(data.expire || 7200);
    feishuTokenCache = {
      token: String(data.tenant_access_token),
      expireAt: now + ttlSec * 1000,
    };
    api.logger?.info?.(
      `[luckee] feishu tenant token: obtained from ${source || "unknown"}, expires in ${ttlSec}s`
    );
    return feishuTokenCache.token;
  } catch (err: any) {
    api.logger?.warn?.(
      `[luckee] feishu tenant token: fetch error: ${String(err?.message || err)}`
    );
    return null;
  }
}

async function updateFeishuCardNative(
  api: any,
  messageId: string,
  text: string,
  options: FeishuCardOptions = {}
): Promise<boolean> {
  try {
    const token = await getFeishuTenantToken(api);
    if (!token) return false;

    const card = buildFeishuCard(text, options);
    api.logger?.info?.(
      `[luckee] feishu card patch payload summary=${summarizeFeishuCard(card)} messageId=${messageId}`
    );
    api.logger?.info?.(
      `[luckee] feishu card patch payload json=${safePreview(JSON.stringify(card), 2500)}`
    );
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msg_type: "interactive", content: JSON.stringify(card) }),
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
    } else {
      api.logger?.info?.(
        `[luckee] feishu native patch ok messageId=${messageId} body=${safePreview(bodyText || "", 1000)}`
      );
    }
    return ok;
  } catch (err: any) {
    api.logger?.warn?.(
      `[luckee] feishu native patch error: ${String(err?.message || err)}`
    );
    return false;
  }
}

async function sendProgressMessageEditable(
  api: any,
  ctx: any,
  text: string,
  prevMessageId?: string,
  options: FeishuCardOptions = {}
): Promise<{ ok: boolean; messageId?: string; edited: boolean }> {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = resolveMessageTarget(ctx);
  if (!channel || !target || !PUSH_CAPABLE_CHANNELS.has(channel)) {
    api.logger?.warn?.(
      `[luckee] sendProgressMessageEditable: skipped (channel=${channel || "empty"} target=${target || "empty"} pushCapable=${PUSH_CAPABLE_CHANNELS.has(channel)})`
    );
    return { ok: false, edited: false };
  }

  // --- EDIT mode: update the existing progress message ---
  if (prevMessageId) {
    api.logger?.info?.(
      `[luckee] sendProgressMessageEditable: EDIT mode channel=${channel} messageId=${prevMessageId}`
    );
    if (channel === "feishu") {
      const ok = await updateFeishuCardNative(api, prevMessageId, text, options);
      if (ok) return { ok: true, messageId: prevMessageId, edited: true };
      api.logger?.warn?.(
        `[luckee] feishu native PATCH failed for ${prevMessageId}; not falling back to openclaw edit for progress cards`
      );
      return { ok: false, messageId: prevMessageId, edited: false };
    }
    const editArgs = [
      "message",
      "edit",
      ...buildMessageArgs(ctx, text),
      "--message-id",
      prevMessageId,
      "--json",
    ];
    const result = await runCommandDetailed("openclaw", editArgs);
    if (result.code === 0) {
      api.logger?.info?.(
        `[luckee] openclaw edit ok: messageId=${prevMessageId} channel=${channel}`
      );
      return { ok: true, messageId: prevMessageId, edited: true };
    }
    api.logger?.warn?.(
      `[luckee] edit failed for messageId=${prevMessageId} channel=${channel}`
    );
    return { ok: false, messageId: prevMessageId, edited: false };
  }

  // --- SEND mode: create the first progress message ---
  api.logger?.info?.(
    `[luckee] sendProgressMessageEditable: SEND mode channel=${channel} target=${target}`
  );
  if (channel === "feishu") {
    const cardResult = await sendFeishuCardNative(api, ctx, text, options);
    if (cardResult.ok && cardResult.messageId) {
      return { ok: true, messageId: cardResult.messageId, edited: false };
    }
    api.logger?.warn?.(
      `[luckee] feishu native card send failed; not falling back to openclaw send for progress cards`
    );
    return { ok: false, edited: false };
  }
  const sendArgs = ["message", "send", ...buildMessageArgs(ctx, text), "--json"];
  const result = await runCommandDetailed("openclaw", sendArgs);
  if (result.code !== 0) {
    api.logger?.warn?.(
      `[luckee] openclaw send failed: channel=${channel} exitCode=${result.code} ` +
      `stderr=${(result.stderr || "").slice(0, 300)}`
    );
    return { ok: false, edited: false };
  }

  const payload =
    parseTrailingJsonObject(result.stdout) || parseTrailingJsonObject(result.stderr);
  const messageId =
    extractMessageId(payload) ||
    extractMessageIdFromRaw(result.stdout) ||
    extractMessageIdFromRaw(result.stderr);
  api.logger?.info?.(
    `[luckee] openclaw send ok: channel=${channel} messageId=${messageId || "none"}`
  );
  return { ok: true, messageId, edited: false };
}

function takeTrackedProcess(
  key?: string
): { proc?: TrackedProcess; kind?: "active" | "auth" } {
  if (key) {
    const active = activeProcesses.get(key);
    if (active) {
      activeProcesses.delete(key);
      return { proc: active, kind: "active" };
    }

    const auth = authWaitSessions.get(key);
    if (auth) {
      authWaitSessions.delete(key);
      return { proc: auth, kind: "auth" };
    }
  }

  if (activeProcesses.size + authWaitSessions.size !== 1) {
    return {};
  }

  if (activeProcesses.size === 1) {
    const [onlyKey, onlyProc] = [...activeProcesses.entries()][0];
    activeProcesses.delete(onlyKey);
    return { proc: onlyProc, kind: "active" };
  }

  if (authWaitSessions.size === 1) {
    const [onlyKey, onlyProc] = [...authWaitSessions.entries()][0];
    authWaitSessions.delete(onlyKey);
    return { proc: onlyProc, kind: "auth" };
  }

  return {};
}

function stopTrackedProcess(
  key?: string
): { stopped: boolean; kind?: "active" | "auth"; query?: string } {
  const { proc, kind } = takeTrackedProcess(key);
  if (!proc) {
    return { stopped: false };
  }

  try {
    proc.kill();
  } catch {
    // Best effort only.
  }

  return {
    stopped: true,
    kind,
    query: proc.query,
  };
}

function extractLuckeeCallbackPayload(ctx: any): Record<string, any> | null {
  const candidates = [
    ctx?.callbackValue,
    ctx?.value,
    ctx?.action?.value,
    ctx?.event?.action?.value,
    ctx?.data?.action?.value,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "object") return candidate;
    const raw = String(candidate || "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Ignore: callback payload may just be plain text.
    }
    return { command: raw, text: raw };
  }
  return null;
}

function resolveLuckeeCommandArgs(ctx: any): string {
  const directArgs = String(ctx?.args ?? "").trim();
  if (directArgs) return directArgs;
  const callbackPayload = extractLuckeeCallbackPayload(ctx);
  const rawCommand = String(
    callbackPayload?.command || callbackPayload?.text || callbackPayload?.action || ""
  ).trim();
  if (!rawCommand) return "";
  if (/^\/luckee(?:\s+|$)/i.test(rawCommand)) {
    return rawCommand.replace(/^\/luckee(?:\s+|$)/i, "").trim();
  }
  return rawCommand === "luckee_stop" ? "stop" : rawCommand;
}

function extractFeishuMessageId(ctx: any): string | undefined {
  const candidates = [
    ctx?.messageId,
    ctx?.message_id,
    ctx?.openMessageId,
    ctx?.open_message_id,
    ctx?.message?.messageId,
    ctx?.message?.message_id,
    ctx?.message?.open_message_id,
    ctx?.action?.messageId,
    ctx?.action?.message_id,
    ctx?.action?.open_message_id,
    ctx?.event?.messageId,
    ctx?.event?.message_id,
    ctx?.event?.open_message_id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return undefined;
}

async function disableFeishuStopButton(
  api: any,
  processKey: string,
  ctx: any,
  fallbackText: string,
  buttonText: string,
  appendStoppedFooter: boolean
): Promise<void> {
  const trackedCard = activeFeishuProgressCards.get(processKey);
  const messageId = trackedCard?.messageId || extractFeishuMessageId(ctx);
  if (!messageId) return;
  const baseText = stripStatusFooter(trackedCard?.text || fallbackText || "当前查询已停止。");
  const nextText = appendStoppedFooter ? withStoppedFooter(baseText) : baseText;
  const ok = await updateFeishuCardNative(api, messageId, nextText, {
    stopButtonDisabled: true,
    stopButtonText: buttonText,
  });
  if (ok) {
    forgetActiveFeishuProgressCard(processKey, trackedCard?.messageId || messageId);
  }
}

async function handleLuckeeStop(api: any, ctx?: any): Promise<string> {
  const processKey = ctx ? getSenderKey(ctx) : "";
  const stopped = stopTrackedProcess(processKey);
  if (stopped.stopped) {
    api.logger?.info?.(
      `[luckee] stop requested: killed ${stopped.kind || "process"} query="${safePreview(stopped.query || "", 80)}"`
    );
  }
  const text = stopped.stopped
    ? stopped.kind === "auth"
      ? `已停止登录等待: ${safePreview(stopped.query || "", 50)}`
      : `已停止查询: ${safePreview(stopped.query || "", 50)}`
    : "当前没有正在运行的查询。";
  if (processKey) {
    await disableFeishuStopButton(
      api,
      processKey,
      ctx,
      text,
      stopped.stopped ? "Query Stopped" : "No Active Query",
      stopped.stopped
    );
  }
  return text;
}

async function saveTokenForContext(
  api: any,
  cfg: LuckeeConfig,
  token: string,
  ctx?: any
): Promise<string> {
  await ensureTokenStoreLoaded(api, cfg);

  if (ctx) {
    const senderKey = getSenderKey(ctx);
    tokenBySender.set(senderKey, token);
    persistedTokenBySenderHash.set(hashSenderKey(senderKey), token);
    api.logger?.info?.(
      `[luckee] token saved for sender=${hashSenderKey(senderKey).slice(0, 8)}`
    );
  } else {
    persistedDefaultToken = token;
    api.logger?.info?.("[luckee] token saved as default (no sender context).");
  }

  await writeTokenStore(cfg);
  return ctx
    ? "Token saved for this chat. You can now run your Luckee query."
    : "Default Luckee token saved.";
}

function buildLuckeeUsageMessage(): string {
  return (
    "Usage:\n" +
    "`/luckee <query>`\n" +
    "`/luckee token <your_token>`\n" +
    "`/luckee token <your_token> <query>`\n" +
    "`/luckee stop`"
  );
}

function parseLuckeeCommandArgs(rawArgs: string): {
  action: "help" | "stop" | "query" | "token";
  query?: string;
  token?: string;
  message?: string;
} {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { action: "help", message: buildLuckeeUsageMessage() };
  }

  if (/^stop$/i.test(trimmed)) {
    return { action: "stop" };
  }

  const tokenMatch = trimmed.match(/^token\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (/^token(?:\s+|$)/i.test(trimmed)) {
    if (!tokenMatch) {
      return {
        action: "help",
        message: "Missing token.\n\n" + buildLuckeeUsageMessage(),
      };
    }
    return {
      action: "token",
      token: tokenMatch[1],
      query: tokenMatch[2]?.trim(),
    };
  }

  return { action: "query", query: trimmed };
}

function settleDetachedAuthWait(params: {
  api: any;
  ctx: any;
  processKey: string;
  sessionId: string;
  query: string;
  origin: "tool" | "command";
  runPromise: Promise<string>;
  getProgressMessageId: () => string | undefined;
  setProgressMessageId: (messageId?: string) => void;
}) {
  const {
    api,
    ctx,
    processKey,
    sessionId,
    query,
    origin,
    runPromise,
    getProgressMessageId,
    setProgressMessageId,
  } = params;

  const updateCard = async (text: string, options: FeishuCardOptions = {}) => {
    const currentSession = authWaitSessions.get(processKey);
    if (!currentSession || currentSession.id !== sessionId) return;
    const currentMessageId = getProgressMessageId();
    if (!currentMessageId) return;
    const result = await sendProgressMessageEditable(api, ctx, text, currentMessageId, options);
    if (result.ok && result.messageId) {
      setProgressMessageId(result.messageId);
        rememberActiveFeishuProgressCard(processKey, result.messageId, text);
      const latest = authWaitSessions.get(processKey);
      if (latest && latest.id === sessionId) {
        latest.messageId = result.messageId;
      }
    }
  };

  void runPromise
    .then(async (output) => {
      const currentSession = authWaitSessions.get(processKey);
      if (!currentSession || currentSession.id !== sessionId) return;

      await updateCard(
        withDoneFooter(normalizeWrappedUrls(output.length > 3500 ? output.slice(-3500) : output)),
        { stopButtonDisabled: true, stopButtonText: "Query Completed" }
      );
      authWaitSessions.delete(processKey);
      forgetActiveFeishuProgressCard(processKey);
      api.logger?.info?.(
        `[luckee] ${origin} success(detached auth wait): query="${safePreview(query)}" outputChars=${output.length}`
      );
    })
    .catch(async (streamErr: any) => {
      const currentSession = authWaitSessions.get(processKey);
      if (!currentSession || currentSession.id !== sessionId) {
        api.logger?.info?.(`[luckee] ${origin} detached auth wait ended after replacement/stop`);
        return;
      }

      const errMsg = String(streamErr?.message || streamErr || "");
      const failText =
        errMsg.includes("timed out") || errMsg.includes("180s")
          ? "⏰ 登录超时，请重试或使用 `/luckee token <your_token>` 设置 token。"
          : `登录后查询失败: ${safePreview(errMsg, 200)}`;
      await updateCard(failText, {
        stopButtonDisabled: true,
        stopButtonText: "Query Failed",
      });
      authWaitSessions.delete(processKey);
      forgetActiveFeishuProgressCard(processKey);
      api.logger?.info?.(
        `[luckee] ${origin} detached auth wait failed: query="${safePreview(query)}" error=${safePreview(errMsg, 200)}`
      );
    });
}

async function executeLuckeeInteractive(
  api: any,
  params: any,
  ctx?: any,
  origin: "tool" | "command" = "tool"
): Promise<InteractiveLuckeeResult> {
  const query = String(params.query ?? "").trim();
  const channel = ctx ? String(ctx.channelId || ctx.channel || "").trim() : "";
  const target = ctx ? resolveMessageTarget(ctx) : "";
  const canPush = Boolean(channel && target && PUSH_CAPABLE_CHANNELS.has(channel));
  const runtimeCfg: LuckeeConfig =
    api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};

  await ensureTokenStoreLoaded(api, runtimeCfg);

  const senderKey = ctx ? getSenderKey(ctx) : "";
  const storedToken = ctx
    ? tokenBySender.get(senderKey) ||
      persistedTokenBySenderHash.get(hashSenderKey(senderKey))
    : undefined;
  const effectiveToken =
    params.token || storedToken || runtimeCfg.defaultToken || persistedDefaultToken;

  if (!canPush) {
    const output = await executeLuckee(api, {
      ...params,
      token: effectiveToken,
      origin,
      persistProvidedToken:
        origin === "tool" && Boolean(params?.token && String(params.token).trim()),
    });
    api.logger?.info?.(
      `[luckee] ${origin} success: query="${safePreview(query)}" outputChars=${output.length}`
    );
    return { kind: "done", output, usedPush: false };
  }

  try {
    if (origin === "tool" && params?.token && String(params.token).trim()) {
      persistedDefaultToken = String(params.token).trim();
      await writeTokenStore(runtimeCfg);
      api.logger?.info?.("[luckee] persisted default token from tool invocation.");
    }

    const interruptedExisting = stopTrackedProcess(senderKey);
    if (interruptedExisting.stopped) {
      api.logger?.info?.(
        `[luckee] ${origin} interrupted prior ${interruptedExisting.kind || "process"} for sender=${hashSenderKey(senderKey).slice(0, 8)} query="${safePreview(interruptedExisting.query || "", 80)}"`
      );
    }

    const { cfg, args } = resolveLuckeeInvocation(api, {
      ...params,
      token: effectiveToken,
    });
    logLuckeeInvocation(api, origin, {
      query: safePreview(query),
      hasToken: Boolean(effectiveToken),
      token: redactToken(String(effectiveToken || "")),
      channel,
      streaming: true,
    });

    const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
    api.logger?.info?.(`[luckee] ${origin} resolved binary: ${binaryPath}`);
    api.logger?.info?.(
      `[luckee] ${origin} cli args: ${JSON.stringify(redactCliArgs(args))}`
    );

    const flushEveryMs = Math.max(300, Number(runtimeCfg.streamFlushMs ?? 1000));
    let progressMessageId: string | undefined;
    let accumulated = "";
    let loadingTick = 0;
    let loginDetected = false;
    const processKey = senderKey;
    const abortHandle: { kill: () => void } = { kill: () => {} };
    const initText = `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
    const initResult = await sendProgressMessageEditable(api, ctx, initText);
    if (initResult.ok && initResult.messageId) {
      progressMessageId = initResult.messageId;
      rememberActiveFeishuProgressCard(processKey, initResult.messageId, initText);
      api.logger?.info?.(
        `[luckee] ${origin} initial progress sent: messageId=${initResult.messageId} channel=${channel}`
      );
    }
    activeProcesses.set(processKey, { kill: () => abortHandle.kill(), query });

    let resolveAuthWaitReady: ((sessionId: string) => void) | null = null;
    const authWaitReady = new Promise<string>((resolve) => {
      resolveAuthWaitReady = resolve;
    });

    const pushProgress = async (chunk?: string) => {
      if (loginDetected) return;
      if (chunk) {
        accumulated = accumulated ? `${accumulated}${chunk}` : chunk;
        if (accumulated.length > 3500) {
          accumulated = `...(truncated old output)\n${accumulated.slice(-3200)}`;
        }
      }
      if (!accumulated && !progressMessageId) return;

      if (detectLoginRequired(accumulated)) {
        loginDetected = true;
        const authUrl = extractAuthUrl(accumulated);
        const loginResult = await sendProgressMessageEditable(
          api,
          ctx,
          buildLoginRequiredMessage(authUrl),
          progressMessageId
        );
        if (loginResult.ok) {
          progressMessageId = loginResult.messageId || progressMessageId;
          rememberActiveFeishuProgressCard(processKey, progressMessageId, buildLoginRequiredMessage(authUrl));
        }

        const session = createAuthWaitSession(
          query,
          () => abortHandle.kill(),
          authUrl,
          progressMessageId,
          origin
        );
        replaceAuthWaitSession(processKey, session);
        activeProcesses.delete(processKey);
        resolveAuthWaitReady?.(session.id);
        resolveAuthWaitReady = null;
        return;
      }

      const displayText = accumulated
        ? normalizeWrappedUrls(accumulated)
        : `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
      const progressText = withProgressFooter(displayText, loadingTick);
      loadingTick += 1;

      const edited = await sendProgressMessageEditable(
        api, ctx, progressText, progressMessageId
      );
      if (edited.ok) {
        progressMessageId = edited.messageId || progressMessageId;
        rememberActiveFeishuProgressCard(processKey, progressMessageId, progressText);
      }
    };

    try {
      const runPromise = runCommandStreaming(
        binaryPath,
        args,
        async (chunk) => pushProgress(chunk),
        flushEveryMs,
        async () => pushProgress(),
        abortHandle
      );
      const runResultPromise: Promise<StreamingRaceResult> = runPromise.then(
        (output) => ({ kind: "done", output }),
        (error) => ({ kind: "error", error })
      );
      const authResultPromise: Promise<StreamingRaceResult> = authWaitReady.then((sessionId) => ({
        kind: "auth",
        sessionId,
      }));
      const result = await Promise.race([runResultPromise, authResultPromise]);

      if (result.kind === "auth") {
        settleDetachedAuthWait({
          api,
          ctx,
          processKey,
          sessionId: result.sessionId,
          query,
          origin,
          runPromise,
          getProgressMessageId: () => progressMessageId,
          setProgressMessageId: (messageId) => {
            progressMessageId = messageId;
          },
        });
        api.logger?.info?.(
          `[luckee] ${origin} detached auth wait: query="${safePreview(query)}" sessionId=${result.sessionId}`
        );
        return {
          kind: "auth-pending",
          message:
            "Luckee authentication is pending in the background. " +
            "I posted the auth instructions in chat. After you finish login, ask me again.",
          usedPush: true,
        };
      }

      if (result.kind === "error") {
        throw result.error;
      }

      const output = result.output;

      if (progressMessageId) {
        const finalText = withDoneFooter(
          normalizeWrappedUrls(output.length > 3500 ? output.slice(-3500) : output)
        );
        const finalResult = await sendProgressMessageEditable(api, ctx, finalText, progressMessageId, {
          stopButtonDisabled: true,
          stopButtonText: "Query Completed",
        });
        if (finalResult.ok && finalResult.messageId) {
          progressMessageId = finalResult.messageId;
        }
        forgetActiveFeishuProgressCard(processKey, progressMessageId);
      }

      api.logger?.info?.(
        `[luckee] ${origin} success(streamed): query="${safePreview(query)}" outputChars=${output.length}`
      );
      return { kind: "done", output, usedPush: true };
    } finally {
      activeProcesses.delete(processKey);
    }
  } catch (err: any) {
    api.logger?.error?.(
      `[luckee] ${origin} failed: query="${safePreview(query)}" error=${String(err?.message || err)}`
    );
    throw err;
  }
}

export default function register(api: any) {
  api.registerCommand({
    name: "luckee",
    description: "Run Luckee queries directly from chat.",
    acceptsArgs: true,
    async handler(ctx: any) {
      const parsed = parseLuckeeCommandArgs(resolveLuckeeCommandArgs(ctx));
      const runtimeCfg: LuckeeConfig =
        api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};

      if (parsed.action === "help") {
        return { text: parsed.message || buildLuckeeUsageMessage() };
      }

      if (parsed.action === "stop") {
        const stopText = await handleLuckeeStop(api, ctx);
        return { text: stopText };
      }

      if (parsed.action === "token") {
        const token = String(parsed.token || "").trim();
        if (!token) {
          return { text: "Missing token.\n\n" + buildLuckeeUsageMessage() };
        }

        const savedText = await saveTokenForContext(api, runtimeCfg, token, ctx);
        if (!parsed.query) {
          return { text: savedText };
        }

        const result = await executeLuckeeInteractive(
          api,
          { query: parsed.query },
          ctx,
          "command"
        );
        if (result.kind === "auth-pending") {
          return { text: result.message };
        }
        return result.usedPush ? {} : { text: result.output };
      }

      const result = await executeLuckeeInteractive(
        api,
        { query: parsed.query },
        ctx,
        "command"
      );
      if (result.kind === "auth-pending") {
        return { text: result.message };
      }
      return result.usedPush ? {} : { text: result.output };
    },
  });

  api.registerTool(
    {
      name: "luckee_query",
      description: "Run a query through luckee CLI.",
      parameters: Type.Object({
        query: Type.String(),
        token: Type.Optional(Type.String()),
        userId: Type.Optional(Type.String()),
        language: Type.Optional(Type.String()),

        timeout: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: any, ctx?: any) {
        const result = await executeLuckeeInteractive(api, params, ctx, "tool");
        return {
          content: [
            {
              type: "text",
              text: result.kind === "auth-pending" ? result.message : result.output,
            },
          ],
        };
      },
    }
  );

  api.registerTool(
    {
      name: "luckee_set_token",
      description:
        "Persist a Luckee token for the current chat sender. " +
        "Call this when the user provides `/luckee token <token>` or wants to save/update their token.",
      parameters: Type.Object({
        token: Type.String(),
      }),
      async execute(_id: string, params: any, ctx?: any) {
        const token = String(params.token ?? "").trim();
        if (!token) {
          throw new Error("Missing token.");
        }

        const runtimeCfg: LuckeeConfig =
          api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
        return {
          content: [
            {
              type: "text",
              text: await saveTokenForContext(api, runtimeCfg, token, ctx),
            },
          ],
        };
      },
    }
  );

  api.registerTool(
    {
      name: "luckee_stop",
      description:
        "Stop a currently running luckee query. " +
        "Call this tool when the user wants to stop, cancel, or abort a running luckee query.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any, ctx?: any) {
        const stopText = await handleLuckeeStop(api, ctx);
        return {
          content: [{ type: "text", text: stopText }],
        };
      },
    }
  );
}
