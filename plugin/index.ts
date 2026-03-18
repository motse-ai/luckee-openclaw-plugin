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
  "--extra-index-url https://pypi.org/simple " +
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

const resolvedBinaryByConfig = new Map<string, string>();
const attemptedAutoInstallByConfig = new Set<string>();
const tokenBySender = new Map<string, string>();
const persistedTokenBySenderHash = new Map<string, string>();
let persistedDefaultToken: string | undefined;
let tokenStoreLoaded = false;
let tokenStoreLoadPromise: Promise<void> | null = null;
const activeProcesses = new Map<string, { kill: () => void; query: string }>();

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

function runCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ completed: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({ completed: true, output: stderr.trim() || stdout.trim() || "command failed", code: -1 });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ completed: true, output: (stdout + stderr).trim(), code });
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      resolve({ completed: false, output: (stdout + stderr).trim(), code: null });
    }, timeoutMs);
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
    lower.includes("open this url to continue login")
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

  // PATH-based probe failed; check common pip script directories
  const scriptDirs = await getPipScriptsDirs(cfg);
  for (const dir of scriptDirs) {
    for (const name of ["luckee-cli", "luckee"]) {
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
        for (const name of ["luckee-cli", "luckee"]) {
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

async function sendProgressMessageEditable(
  api: any,
  ctx: any,
  text: string,
  prevMessageId?: string
): Promise<{ ok: boolean; messageId?: string; edited: boolean }> {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = String(ctx.to || ctx.from || ctx.senderId || "").trim();
  if (!channel || !target || !PUSH_CAPABLE_CHANNELS.has(channel)) {
    api.logger?.warn?.(
      `[luckee] sendProgressMessageEditable: skipped (channel=${channel || "empty"} target=${target || "empty"} pushCapable=${PUSH_CAPABLE_CHANNELS.has(channel)})`
    );
    return { ok: false, edited: false };
  }

  // --- EDIT mode: only try to update the existing message, never create new ones ---
  if (prevMessageId) {
    api.logger?.info?.(
      `[luckee] sendProgressMessageEditable: EDIT mode channel=${channel} messageId=${prevMessageId}`
    );
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
    const editError = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    api.logger?.warn?.(
      `[luckee] all edit attempts failed: messageId=${prevMessageId} channel=${channel} ` +
      `exitCode=${result.code} stderr=${(result.stderr || "").slice(0, 300)}`
    );
    api.logger?.info?.(
      `[luckee] keeping single progress message only: messageId=${prevMessageId} ` +
      `channel=${channel} reason=${safePreview(editError, 160)}`
    );
    return { ok: false, messageId: prevMessageId, edited: false };
  }

  // --- SEND mode: create the first message through OpenClaw only ---
  api.logger?.info?.(
    `[luckee] sendProgressMessageEditable: SEND mode channel=${channel} target=${target}`
  );
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

        timeout: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: any, ctx?: any) {
        const query = String(params.query ?? "").trim();
        const channel = ctx ? String(ctx.channelId || ctx.channel || "").trim() : "";
        const target = ctx ? String(ctx.to || ctx.from || ctx.senderId || "").trim() : "";
        const canPush = Boolean(channel && target && PUSH_CAPABLE_CHANNELS.has(channel));

        if (!canPush) {
          try {
            const output = await executeLuckee(api, params);
            api.logger?.info?.(
              `[luckee] tool success: query="${safePreview(query)}" outputChars=${output.length}`
            );
            return { content: [{ type: "text", text: output }] };
          } catch (err: any) {
            api.logger?.error?.(
              `[luckee] tool failed: query="${safePreview(query)}" error=${String(err?.message || err)}`
            );
            throw err;
          }
        }

        try {
          const runtimeCfg: LuckeeConfig =
            api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
          await ensureTokenStoreLoaded(api, runtimeCfg);
          if (params?.token && String(params.token).trim()) {
            persistedDefaultToken = String(params.token).trim();
            await writeTokenStore(runtimeCfg);
            api.logger?.info?.("[luckee] persisted default token from tool invocation.");
          }

          const senderKey = getSenderKey(ctx);
          const storedToken =
            tokenBySender.get(senderKey) ||
            persistedTokenBySenderHash.get(hashSenderKey(senderKey));
          const effectiveToken =
            params.token || storedToken || runtimeCfg.defaultToken || persistedDefaultToken;

          const { cfg, args } = resolveLuckeeInvocation(api, {
            ...params,
            token: effectiveToken,
          });
          logLuckeeInvocation(api, "tool", {
            query: safePreview(query),
            hasToken: Boolean(effectiveToken),
            token: redactToken(String(effectiveToken || "")),
            channel,
            streaming: true,
          });

          const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
          api.logger?.info?.(`[luckee] tool resolved binary: ${binaryPath}`);
          api.logger?.info?.(
            `[luckee] tool cli args: ${JSON.stringify(redactCliArgs(args))}`
          );

          const flushEveryMs = Math.max(300, Number(runtimeCfg.streamFlushMs ?? 1000));
          let progressMessageId: string | undefined;
          let accumulated = "";
          let loadingTick = 0;
          const abortHandle: { kill: () => void } = { kill: () => {} };
          if (PUSH_CAPABLE_CHANNELS.has(channel)) {
            const initText = `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
            const initResult = await sendProgressMessageEditable(api, ctx, initText);
            if (initResult.ok && initResult.messageId) {
              progressMessageId = initResult.messageId;
              api.logger?.info?.(
                `[luckee] tool initial progress sent: messageId=${initResult.messageId} channel=${channel}`
              );
            }
          }

          const processKey = getSenderKey(ctx);
          activeProcesses.set(processKey, { kill: () => abortHandle.kill(), query });

          const pushProgress = async (chunk?: string) => {
            if (chunk) {
              accumulated = accumulated ? `${accumulated}${chunk}` : chunk;
              if (accumulated.length > 3500) {
                accumulated = `...(truncated old output)\n${accumulated.slice(-3200)}`;
              }
            }
            if (!accumulated && !progressMessageId) return;

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
            }
          };

          try {
            const output = await runCommandStreaming(
              binaryPath,
              args,
              async (chunk) => pushProgress(chunk),
              flushEveryMs,
              async () => pushProgress(),
              abortHandle
            );

            if (progressMessageId) {
              const finalText = withDoneFooter(
                normalizeWrappedUrls(output.length > 3500 ? output.slice(-3500) : output)
              );
              const finalResult = await sendProgressMessageEditable(api, ctx, finalText, progressMessageId);
              if (finalResult.ok && finalResult.messageId) {
                progressMessageId = finalResult.messageId;
              }
            }

            api.logger?.info?.(
              `[luckee] tool success(streamed): query="${safePreview(query)}" outputChars=${output.length}`
            );
            return { content: [{ type: "text", text: output }] };
          } finally {
            activeProcesses.delete(processKey);
          }
        } catch (err: any) {
          api.logger?.error?.(
            `[luckee] tool failed: query="${safePreview(query)}" error=${String(err?.message || err)}`
          );
          throw err;
        }
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
        const key = ctx ? getSenderKey(ctx) : "";
        let proc = key ? activeProcesses.get(key) : undefined;
        if (!proc && activeProcesses.size === 1) {
          const [onlyKey, onlyProc] = [...activeProcesses.entries()][0];
          proc = onlyProc;
          if (proc) {
            proc.kill();
            activeProcesses.delete(onlyKey);
            api.logger?.info?.(`[luckee] stop tool: killed query="${safePreview(proc.query, 80)}"`);
            return {
              content: [{ type: "text", text: `已停止查询: ${safePreview(proc.query, 50)}` }],
            };
          }
        }
        if (proc) {
          proc.kill();
          activeProcesses.delete(key);
          api.logger?.info?.(`[luckee] stop tool: killed query="${safePreview(proc.query, 80)}"`);
          return {
            content: [{ type: "text", text: `已停止查询: ${safePreview(proc.query, 50)}` }],
          };
        }
        return {
          content: [{ type: "text", text: "当前没有正在运行的查询。" }],
        };
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
              "/luckee token <token> <query>\n" +
              "/luckee stop — 停止正在运行的查询\n\n" +
              "Example: /luckee token sk_xxx 查一下 asin B0FFGNZ36F 的信息 用skills",
          };
        }
        const lowerArgs = rawArgs.toLowerCase();
        if (lowerArgs === "login" || lowerArgs === "logout") {
          const cfg: LuckeeConfig =
            api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
          const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
          logLuckeeInvocation(api, "command", {
            action: lowerArgs,
            channel: String(ctx.channelId || ctx.channel || ""),
            sender: String(ctx.from || ctx.senderId || ""),
          });

          if (lowerArgs === "login") {
            try {
              const result = await runCommandWithTimeout(binaryPath, ["login"], 15_000);
              if (result.completed && result.code === 0) {
                return { text: result.output || "luckee login completed." };
              }
              if (result.completed) {
                return { text: `luckee login failed (exit ${result.code}):\n${result.output}` };
              }

              api.logger?.warn?.(
                `[luckee] login timed out — OAuth callback unreachable in gateway subprocess. output=${result.output.slice(0, 500)}`
              );
              const authUrl = extractAuthUrl(result.output);
              const urlNote = authUrl
                ? `\nDetected auth URL (likely incomplete redirect_uri):\n${authUrl}\n`
                : "";
              return {
                text:
                  "It seems the OAuth login flow isn't working properly in this environment (the redirect_uri is empty).\n" +
                  urlNote +
                  "\n**Alternative option:** Do you have a Luckee API token? If so, you can set it directly without browser login:\n\n" +
                  "```\n/luckee token <your_token>\n```\n\n" +
                  "Or I can configure it via:\n\n" +
                  "```\nopenclaw config set plugins.entries.luckee-tool.config.defaultToken \"<your_token>\"\n```\n\n" +
                  "Would you like to provide a token, or would you prefer to try fixing the browser login another way?",
              };
            } catch (err: any) {
              return { text: `luckee login failed: ${String(err?.message || err)}` };
            }
          }

          try {
            const output = await runCommand(binaryPath, [lowerArgs]);
            return { text: output || `luckee ${lowerArgs} completed.` };
          } catch (err: any) {
            return { text: `luckee ${lowerArgs} failed: ${String(err?.message || err)}` };
          }
        }

        if (lowerArgs === "stop") {
          const key = getSenderKey(ctx);
          const proc = activeProcesses.get(key);
          if (proc) {
            proc.kill();
            activeProcesses.delete(key);
            return { text: `已停止查询: ${safePreview(proc.query, 50)}` };
          }
          return { text: "当前没有正在运行的查询。" };
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
        let loginDetected = false;
        const abortHandle: { kill: () => void } = { kill: () => {} };
        const flushEveryMs = Math.max(300, Number(cfg.streamFlushMs ?? 1000));
        const channel = String(ctx.channelId || ctx.channel || "").trim();

        api.logger?.info?.(
          `[luckee] command: channel=${channel} ctx.to=${ctx.to || ""} ctx.from=${ctx.from || ""} ` +
          `ctx.chatId=${ctx.chatId || ctx.chat_id || ""} ctx.senderId=${ctx.senderId || ""} ` +
          `ctx.channelId=${ctx.channelId || ""} ctx.accountId=${ctx.accountId || ""}`
        );

        if (PUSH_CAPABLE_CHANNELS.has(channel)) {
          const initText = `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
          const initResult = await sendProgressMessageEditable(api, ctx, initText);
          if (initResult.ok && initResult.messageId) {
            progressMessageId = initResult.messageId;
            streamed = true;
            api.logger?.info?.(
              `[luckee] initial progress sent: messageId=${initResult.messageId} channel=${channel}`
            );
          } else {
            api.logger?.warn?.(
              `[luckee] initial progress FAILED: channel=${channel}`
            );
          }
        } else {
          api.logger?.info?.(
            `[luckee] channel=${channel} is not push-capable, skipping initial card`
          );
        }

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
            const loginText =
              "🔐 **需要登录**\n\n" +
              "Luckee 检测到当前未登录或 token 已失效。\n\n" +
              (authUrl ? `授权链接:\n${authUrl}\n\n` : "") +
              "请通过以下方式之一进行认证：\n\n" +
              "**方式一：** 在终端运行 `luckee login` 完成浏览器授权\n\n" +
              "**方式二：** 使用 token\n```\n/luckee token <your_token>\n```\n\n" +
              "**方式三：** 配置默认 token\n```\nopenclaw config set plugins.entries.luckee-tool.config.defaultToken \"<your_token>\"\n```";
            const loginResult = await sendProgressMessageEditable(api, ctx, loginText, progressMessageId);
            if (loginResult.ok) {
              progressMessageId = loginResult.messageId || progressMessageId;
            }
            streamed = true;
            return;
          }

          const displayText = accumulated
            ? normalizeWrappedUrls(accumulated)
            : `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
          const progressText = withProgressFooter(displayText, loadingTick);
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
          }
        };

        const processKey = getSenderKey(ctx);
        activeProcesses.set(processKey, { kill: () => abortHandle.kill(), query });

        try {
          const output = await runCommandStreaming(
            binaryPath,
            args,
            async (chunk) => pushProgress(chunk),
            flushEveryMs,
            async () => pushProgress(),
            abortHandle
          );

          const updateCard = async (text: string) => {
            if (!progressMessageId) return;
            const result = await sendProgressMessageEditable(api, ctx, text, progressMessageId);
            if (result.ok && result.messageId) {
              progressMessageId = result.messageId;
            }
          };

          if (loginDetected) {
            if (progressMessageId) {
              const finalText = withDoneFooter(
                normalizeWrappedUrls(output.length > 3500 ? output.slice(-3500) : output)
              );
              await updateCard(finalText);
            }
            api.logger?.info?.(
              `[luckee] command success(after login): query="${safePreview(query)}" outputChars=${output.length}`
            );
            return streamed ? { text: "" } : { text: output };
          }

          if (streamed) {
            if (progressMessageId) {
              const finalText = withDoneFooter(
                normalizeWrappedUrls(output.length > 3500 ? output.slice(-3500) : output)
              );
              await updateCard(finalText);
            }
            api.logger?.info?.(
              `[luckee] command success(streamed): query="${safePreview(query)}" outputChars=${output.length}`
            );
            return { text: "" };
          }
          api.logger?.info?.(
            `[luckee] command success: query="${safePreview(query)}" outputChars=${output.length}`
          );
          return { text: output };
        } catch (streamErr: any) {
          const updateCardOnError = async (text: string) => {
            if (!progressMessageId) return;
            const result = await sendProgressMessageEditable(api, ctx, text, progressMessageId);
            if (result.ok && result.messageId) {
              progressMessageId = result.messageId;
            }
          };

          if (loginDetected) {
            api.logger?.info?.("[luckee] command failed after login prompt");
            if (progressMessageId) {
              const errMsg = String(streamErr?.message || streamErr || "");
              const failText =
                errMsg.includes("timed out") || errMsg.includes("180s")
                  ? "⏰ 登录超时，请重试或使用 `/luckee token <your_token>` 设置 token。"
                  : `登录后查询失败: ${safePreview(errMsg, 200)}`;
              await updateCardOnError(failText);
            }
            return streamed ? { text: "" } : { text: "查询未完成，请检查登录状态后重试。" };
          }
          if (!activeProcesses.has(processKey)) {
            api.logger?.info?.("[luckee] command stopped by user");
            if (progressMessageId) {
              const stoppedText =
                (accumulated ? normalizeWrappedUrls(accumulated) + "\n\n" : "") +
                "⛔ 查询已被手动停止";
              await updateCardOnError(stoppedText);
            }
            return streamed ? { text: "" } : { text: "查询已被手动停止。" };
          }
          throw streamErr;
        } finally {
          activeProcesses.delete(processKey);
        }
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

  api.registerCommand({
    name: "stop",
    description: "Stop a running luckee query.",
    acceptsArgs: false,
    requireAuth: false,
    handler: async (ctx: any) => {
      const key = getSenderKey(ctx);
      const proc = activeProcesses.get(key);
      if (proc) {
        proc.kill();
        activeProcesses.delete(key);
        return { text: `已停止查询: ${safePreview(proc.query, 50)}` };
      }
      return { text: "当前没有正在运行的查询。" };
    },
  });
}
