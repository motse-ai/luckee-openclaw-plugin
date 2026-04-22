import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Terminal } from "ansi-to-pre";
import stripAnsi from "strip-ansi";

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
  title?: string;
};

type ActiveFeishuProgressCard = {
  messageId: string;
  text: string;
};

type CliChunkLogger = (stream: "stdout" | "stderr", chunk: string) => void;
type AbortHandle = {
  kill: () => void;
  stopRequested?: boolean;
};

type StreamingRaceResult =
  | { kind: "done"; output: string }
  | { kind: "error"; error: any }
  | { kind: "auth"; sessionId: string };

type InteractiveLuckeeResult =
  | { kind: "done"; output: string; usedPush: boolean }
  | { kind: "stopped"; output: string; usedPush: boolean }
  | { kind: "auth-pending"; message: string; usedPush: boolean };

type LuckeeControlResult =
  | { kind: "done"; output: string; usedPush: boolean }
  | { kind: "stopped"; output: string; usedPush: boolean };

type LuckeeCommandAction =
  | "help"
  | "stop"
  | "query"
  | "token"
  | "login"
  | "logout";

const activeProcesses = new Map<string, TrackedProcess>();
const authWaitSessions = new Map<string, AuthWaitSession>();
const activeFeishuProgressCards = new Map<string, ActiveFeishuProgressCard>();
const activeProgressMessageIds = new Map<string, string>();
const discordMessageChannelTargetById = new Map<string, string>();

type CachedMessageCtx = {
  channelId: string;
  conversationId?: string;
  accountId?: string;
  from: string;
  to?: string;
  threadId?: string | number;
};
const lastMessageCtx = new Map<string, CachedMessageCtx>();

// ── Attachment state ──────────────────────────────────────────────────────────

type AttachmentRef =
  | {
      kind: "feishu_file";
      messageId: string;
      fileKey: string;
      fileType: "file" | "image" | "audio" | "video";
      fileName: string;
    }
  | {
      kind: "url";
      url: string;
      fileName: string;
    };

/** Pending attachments per sender, cleared when consumed by the next query. */
const pendingAttachmentsBySender = new Map<string, AttachmentRef[]>();

function pushPendingAttachment(senderKey: string, ref: AttachmentRef): void {
  const list = pendingAttachmentsBySender.get(senderKey) ?? [];
  list.push(ref);
  pendingAttachmentsBySender.set(senderKey, list);
  if (pendingAttachmentsBySender.size > 500) {
    const first = pendingAttachmentsBySender.keys().next().value;
    if (first) pendingAttachmentsBySender.delete(first);
  }
}

function popPendingAttachments(senderKey: string): AttachmentRef[] {
  const refs = pendingAttachmentsBySender.get(senderKey) ?? [];
  pendingAttachmentsBySender.delete(senderKey);
  return refs;
}

function cacheMessageCtx(
  channelId: string,
  accountId: string | undefined,
  from: string,
  extra?: Partial<CachedMessageCtx>
): void {
  if (!channelId || !from) return;
  const entry: CachedMessageCtx = { channelId, accountId, from, ...extra };
  const senderKey = `${channelId}|${accountId || ""}|${from}`;
  lastMessageCtx.set(senderKey, entry);
  const channelKey = `${channelId}|${accountId || ""}|*`;
  lastMessageCtx.set(channelKey, entry);
  if (lastMessageCtx.size > 1000) {
    const first = lastMessageCtx.keys().next().value;
    if (first) lastMessageCtx.delete(first);
  }
}

function lookupCachedMessageCtx(
  channel: string,
  account: string | undefined,
  sender: string | undefined
): CachedMessageCtx | undefined {
  if (sender) {
    const exact = lastMessageCtx.get(`${channel}|${account || ""}|${sender}`);
    if (exact) return exact;
  }
  return lastMessageCtx.get(`${channel}|${account || ""}|*`);
}

/** Cron / isolated tool runs often omit the real sender; placeholders must not become Feishu receive_ids. */
function isPlaceholderToolActorId(id: string | undefined): boolean {
  const s = String(id ?? "").trim().toLowerCase();
  return (
    !s ||
    s === "?" ||
    s === "unknown" ||
    s === "anonymous" ||
    s === "none" ||
    s === "undefined" ||
    s === "null"
  );
}

/**
 * OpenClaw session keys often embed the Feishu peer id, e.g.
 * `agent:main:feishu:direct:ou_f159d843ed4d1190628ec29a09f07bcc`.
 * Plugin tool context does not receive cron `delivery.to`, but `sessionKey` does.
 */
function parseFeishuPeerFromOpenClawSessionKey(sessionKey: string | undefined): string | undefined {
  const s = String(sessionKey ?? "").trim();
  if (!s) return undefined;
  const m = s.match(/\b(oc_[0-9a-zA-Z]+|ou_[0-9a-zA-Z]+|on_[0-9a-zA-Z]+)\b/);
  return m ? m[1] : undefined;
}

function buildToolChannelCtx(toolCtx: any): any | undefined {
  const channel = toolCtx?.messageChannel;
  const rawSender = String(toolCtx?.requesterSenderId || "").trim();
  const sender = isPlaceholderToolActorId(rawSender) ? undefined : rawSender || undefined;
  const account = (toolCtx?.agentAccountId || "").trim() || undefined;
  if (!channel) return undefined;

  const cached = lookupCachedMessageCtx(channel, account, sender);
  const effectiveSender = sender || cached?.from;
  let target = cached?.conversationId || cached?.to || effectiveSender;

  const isFeishu = String(channel).trim() === "feishu";
  if (isFeishu && (!target || isPlaceholderToolActorId(String(target)))) {
    const fromSession = parseFeishuPeerFromOpenClawSessionKey(toolCtx?.sessionKey);
    if (fromSession) target = fromSession;
  }

  if (!target || isPlaceholderToolActorId(String(target))) return undefined;

  const ctx = {
    channel,
    channelId: channel,
    from: effectiveSender || target,
    senderId: effectiveSender || target,
    to: target,
    chatId: target,
    chat_id: target,
    accountId: account || cached?.accountId,
    messageThreadId: cached?.threadId,
  };

  // Isolated sessions may still have channel=feishu but no routable chat/user id — skip push, return tool text only.
  if (isFeishu && !resolveFeishuReceiveId(ctx)) {
    return undefined;
  }

  return ctx;
}
const FEISHU_CARD_CHUNK_SIZE = 2400;
const FEISHU_FINAL_OUTPUT_PART_SIZE = Number.POSITIVE_INFINITY;

/** luckee CLI `--timeout` floor (seconds). Callers may not pass a lower `timeout`; omit to use this value. */
const LUCKEE_CLI_MIN_TIMEOUT_SECONDS = 1800;

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

function createLuckeeStoppedError(): Error & { code: string; luckeeStopped: true } {
  const err = new Error("Luckee query stopped.");
  (err as Error & { code: string; luckeeStopped: true }).code = "LUCKEE_STOPPED";
  (err as Error & { code: string; luckeeStopped: true }).luckeeStopped = true;
  return err as Error & { code: string; luckeeStopped: true };
}

function isLuckeeStoppedError(err: any): boolean {
  return err?.code === "LUCKEE_STOPPED" || err?.luckeeStopped === true;
}

function isLikelyTimeoutLuckeeError(err: any): boolean {
  if (err?.code === "LUCKEE_INVALID_TIMEOUT") return false;
  if (err?.code === "ETIMEDOUT" || err?.name === "TimeoutError") return true;
  const m = String(err?.message || err || "").toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("time out") ||
    m.includes("deadline exceeded") ||
    m.includes("read timed out") ||
    m.includes("connection timed out") ||
    m.includes("execution time") ||
    /\b(tool|invocation).{0,48}(timed out|timeout|time limit)\b/i.test(m)
  );
}

/** User- and model-facing text when luckee_query throws (timeout, CLI failure, etc.). */
function formatLuckeeQueryToolFailureMessage(err: any, queryPreview: string): string {
  const raw = String(err?.message || err || "Unknown error");
  const qLine = queryPreview.trim()
    ? `Query (preview): ${queryPreview.trim()}\n\n`
    : "";
  if (isLuckeeStoppedError(err)) {
    return `${qLine}Luckee query was stopped before completion.\n\n${safePreview(raw, 1500)}`;
  }
  if (isLikelyTimeoutLuckeeError(err)) {
    return (
      `${qLine}` +
      `Luckee query **timed out** before completion.\n\n` +
      `The luckee CLI, network, or upstream session reported a timeout. ` +
      `Retry with a larger \`timeout\` value (seconds) on \`luckee_query\` if the task legitimately needs more time, or suggest the user narrow the query.\n\n` +
      `---\nTechnical detail:\n${safePreview(raw, 2000)}`
    );
  }
  return (
    `${qLine}Luckee query **failed** (process exited with an error or could not complete).\n\n` +
    `---\n${safePreview(raw, 4000)}`
  );
}

/**
 * OpenClaw plugin tool return shape (primary path for the agent is `result` + `details`).
 * @see https://openclaw-openclaw.mintlify.app/plugins/tools — `content` kept for compatibility with older docs/examples.
 */
function luckeeToolReturnSuccess(text: string) {
  return {
    result: "success" as const,
    details: { text },
    content: [{ type: "text" as const, text }],
  };
}

function luckeeToolReturnPending(text: string) {
  return {
    result: "pending" as const,
    details: { text },
    content: [{ type: "text" as const, text }],
  };
}

function luckeeToolReturnError(text: string) {
  return {
    result: "error" as const,
    error: text,
    details: { text },
    content: [{ type: "text" as const, text }],
  };
}

function logLuckeeInvocation(api: any, origin: "tool" | "command", info: Record<string, any>): void {
  try {
    api.logger?.info?.(`[luckee] ${origin} invocation: ${JSON.stringify(info)}`);
  } catch {
    api.logger?.info?.(`[luckee] ${origin} invocation`);
  }
}

function logLuckeeCliChunk(
  api: any,
  origin: "tool" | "command",
  stream: "stdout" | "stderr",
  chunk: string
): void {
  if (!chunk) return;
  try {
    api.logger?.info?.(`[luckee] ${origin} cli ${stream} chunk=${JSON.stringify(chunk)}`);
  } catch {
    api.logger?.info?.(`[luckee] ${origin} cli ${stream} chunk=(unserializable)`);
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

function runCommand(
  command: string,
  args: string[],
  abortHandle?: AbortHandle,
  onChunk?: CliChunkLogger
): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnTarget = getSpawnTarget(command, args);
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getChildProcessEnv(),
    });
    let aborted = false;
    if (abortHandle) {
      const performAbort = () => {
        aborted = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      };
      const requestedBeforeBind = abortHandle.stopRequested === true;
      abortHandle.kill = () => {
        abortHandle.stopRequested = true;
        performAbort();
      };
      if (requestedBeforeBind) {
        performAbort();
      }
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      try {
        onChunk?.("stdout", text);
      } catch {
        // Logging hook must never break command execution.
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      try {
        onChunk?.("stderr", text);
      } catch {
        // Logging hook must never break command execution.
      }
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (aborted) {
        reject(createLuckeeStoppedError());
        return;
      }
      if (code === 0) {
        const out = stdout;
        const err = stderr;
        resolve(out || err || "(luckee completed with empty output)");
        return;
      }
      reject(
        new Error(
          `luckee exited with code ${code}\n` +
            `${stderr || stdout || "no output"}`
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
    const spawnTarget = getSpawnTarget(command, args);
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getChildProcessEnv(),
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
    "**方式一：** 点击上面链接在浏览器内完成授权\n\n" +
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

function extractStatusFooter(text: string): { body: string; status?: string } {
  const raw = String(text || "");
  const match = raw.match(
    /\n\n---\n(⏳ Still loading\.{1,3}|✅ Completed|⏹️ Stopped)\s*$/s
  );
  if (!match) return { body: raw };
  const status = String(match[1] || "").trim();
  const body = raw.slice(0, match.index).trimEnd();
  return { body, status };
}

function buildStoppedCardText(currentText: string, stoppedText: string): string {
  const statusText = String(stoppedText || "").trim() || "当前查询已停止。";
  const previousText = stripStatusFooter(currentText || "").trim();
  if (!previousText || previousText === statusText) {
    return withStoppedFooter(statusText);
  }
  return withStoppedFooter(`${statusText}\n\n${previousText}`);
}

function rememberActiveFeishuProgressCard(
  processKey: string,
  messageId: string | undefined,
  text: string
): void {
  if (!processKey || !messageId) return;
  activeFeishuProgressCards.set(processKey, { messageId, text });
}

function rememberActiveProgressMessageId(processKey: string, messageId?: string): void {
  if (!processKey || !messageId) return;
  activeProgressMessageIds.set(processKey, messageId);
}

function forgetActiveProgressMessageId(processKey: string, messageId?: string): void {
  if (!processKey) return;
  const current = activeProgressMessageIds.get(processKey);
  if (!current) return;
  if (messageId && current !== messageId) return;
  activeProgressMessageIds.delete(processKey);
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
  effectiveTimeoutSeconds: number;
} {
  const cfg: LuckeeConfig =
    api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};

  const url = cfg.defaultUrl;
  const userId = params.userId || cfg.defaultUserId;
  const language = params.language || cfg.defaultLanguage || "CN";
  const token = params.token || cfg.defaultToken || persistedDefaultToken;

  const query = String(params.query ?? "").trim();
  if (!query) {
    throw new Error("Missing query.");
  }

  if (params.url && String(params.url).trim()) {
    api.logger?.warn?.("[luckee] Ignored caller-provided url; enforced defaultUrl from plugin config.");
  }

  const rawTimeout = params.timeout;
  let requestedSeconds = 0;
  if (rawTimeout !== undefined && rawTimeout !== null && String(rawTimeout).trim() !== "") {
    const n = Number(rawTimeout);
    if (Number.isFinite(n) && n > 0) {
      requestedSeconds = n;
    }
  }
  if (
    requestedSeconds > 0 &&
    requestedSeconds < LUCKEE_CLI_MIN_TIMEOUT_SECONDS
  ) {
    const err = new Error(
      `luckee_query \`timeout\` must be at least ${LUCKEE_CLI_MIN_TIMEOUT_SECONDS} seconds (received ${requestedSeconds}). Omit \`timeout\` to use ${LUCKEE_CLI_MIN_TIMEOUT_SECONDS}s.`
    ) as Error & { code: string };
    err.code = "LUCKEE_INVALID_TIMEOUT";
    throw err;
  }
  const effectiveTimeoutSeconds = Math.max(
    LUCKEE_CLI_MIN_TIMEOUT_SECONDS,
    requestedSeconds
  );

  const args: string[] = [];
  if (url) args.push("--url", url);
  if (userId) args.push("--user-id", userId);
  args.push("--language", language);
  args.push("--query", query);
  args.push("--timeout", String(effectiveTimeoutSeconds));
  if (token) args.push("--token", String(token));
  if (Array.isArray(params.attachmentPaths)) {
    for (const p of params.attachmentPaths) {
      if (p) args.push("--attachment", String(p));
    }
  }

  return { cfg, args, effectiveTimeoutSeconds };
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
  const { cfg, args, effectiveTimeoutSeconds } = resolveLuckeeInvocation(api, params);
  const origin = params?.origin === "command" ? "command" : "tool";
  logLuckeeInvocation(api, origin, {
    query: safePreview(String(params.query ?? "")),
    hasToken: Boolean(params.token || cfg.defaultToken || persistedDefaultToken),
    token: redactToken(String(params.token || cfg.defaultToken || persistedDefaultToken || "")),
    userId: String(params.userId || cfg.defaultUserId || ""),
    language: String(params.language || cfg.defaultLanguage || "CN"),
    timeoutRequested: params.timeout ?? null,
    timeoutSecondsEffective: effectiveTimeoutSeconds,
    url: String(cfg.defaultUrl || ""),
  });
  const binaryPath = await resolveLuckeeBinaryOrThrow(api, cfg);
  api.logger?.info?.(`[luckee] ${origin} resolved binary: ${binaryPath}`);
  api.logger?.info?.(
    `[luckee] ${origin} cli args: ${JSON.stringify(redactCliArgs(args))}`
  );
  const senderKey = params?.ctx ? getSenderKey(params.ctx) : "";
  const abortHandle: AbortHandle = {
    stopRequested: false,
    kill: () => {
      abortHandle.stopRequested = true;
    },
  };
  if (senderKey) {
    const interruptedExisting = stopTrackedProcess(senderKey);
    if (interruptedExisting.stopped) {
      api.logger?.info?.(
        `[luckee] ${origin} interrupted prior ${interruptedExisting.kind || "process"} for sender=${hashSenderKey(senderKey).slice(0, 8)} query="${safePreview(interruptedExisting.query || "", 80)}"`
      );
    }
    activeProcesses.set(senderKey, { kill: () => abortHandle.kill(), query: String(params.query ?? "").trim() });
  }
  try {
    return await runCommand(
      binaryPath,
      args,
      senderKey ? abortHandle : undefined,
      (stream, chunk) => logLuckeeCliChunk(api, origin, stream, chunk)
    );
  } finally {
    if (senderKey) {
      activeProcesses.delete(senderKey);
    }
  }
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
  abortHandle?: AbortHandle,
  onChunk?: CliChunkLogger
): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnTarget = getSpawnTarget(command, args);
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getChildProcessEnv(),
    });
    let aborted = false;
    if (abortHandle) {
      const performAbort = () => {
        aborted = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      };
      const requestedBeforeBind = abortHandle.stopRequested === true;
      abortHandle.kill = () => {
        abortHandle.stopRequested = true;
        performAbort();
      };
      if (requestedBeforeBind) {
        performAbort();
      }
    }
    let stdout = "";
    let stderr = "";
    let pending = "";

    const flush = async () => {
      if (abortHandle?.stopRequested) {
        pending = "";
        return;
      }
      const text = pending;
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
          if (abortHandle?.stopRequested) return;
          await flush();
          if (abortHandle?.stopRequested) return;
          if (onTick) await onTick();
        })
        .catch(() => undefined);
    };

    const timer = setInterval(queueFlush, flushEveryMs);

    child.stdout.on("data", (chunk) => {
      if (abortHandle?.stopRequested || aborted) return;
      const text = chunk.toString();
      stdout += text;
      pending += text;
      try {
        onChunk?.("stdout", text);
      } catch {
        // Logging hook must never break command execution.
      }
    });

    child.stderr.on("data", (chunk) => {
      if (abortHandle?.stopRequested || aborted) return;
      const text = chunk.toString();
      stderr += text;
      pending += text;
      try {
        onChunk?.("stderr", text);
      } catch {
        // Logging hook must never break command execution.
      }
    });

    child.on("error", (err) => {
      clearInterval(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(timer);
      queue = queue
        .then(async () => {
          if (abortHandle?.stopRequested) {
            pending = "";
            return;
          }
          await flush();
          if (abortHandle?.stopRequested) return;
          if (onTick) await onTick();
        })
        .then(() => {
          if (aborted) {
            reject(createLuckeeStoppedError());
            return;
          }
          if (code === 0) {
            const out = stdout;
            const err = stderr;
            resolve(out || err || "(luckee completed with empty output)");
            return;
          }
          reject(
            new Error(
              `luckee exited with code ${code}\n` +
                `${stderr || stdout || "no output"}`
            )
          );
        })
        .catch(reject);
    });
  });
}

function getSpawnTarget(command: string, args: string[]): { command: string; args: string[] } {
  if (!shouldWrapLuckeeWithScript(command)) {
    return { command, args };
  }
  if (process.platform === "linux") {
    // GNU script requires -c for command execution; otherwise flags like
    // "--language" are parsed as script options instead of Luckee CLI args.
    return {
      command: "script",
      args: ["-q", "-e", "-f", "-c", buildShellCommand(command, args), "/dev/null"],
    };
  }
  return {
    command: "script",
    args: ["-q", "/dev/null", command, ...args],
  };
}

function shouldWrapLuckeeWithScript(command: string): boolean {
  if (process.platform === "win32") return false;
  if (process.env.LUCKEE_DISABLE_SCRIPT_WRAPPER === "1") return false;
  const binaryName = path.basename(command).toLowerCase();
  return binaryName === "luckee" || binaryName === "luckee-cli";
}

function shellQuote(value: string): string {
  if (!value.length) return "''";
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => shellQuote(String(part))).join(" ");
}

function getChildProcessEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1",
  };
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

function extractChannelId(payload: any): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const direct = payload.channelId || payload.channel_id;
  if (direct != null) return String(direct);

  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value && typeof value === "object") {
      const nested = extractChannelId(value);
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

function extractChannelIdFromRaw(text: string): string | undefined {
  const patterns = [
    /"channel_id"\s*:\s*"([^"]+)"/,
    /"channelId"\s*:\s*"([^"]+)"/,
    /"channel_id"\s*:\s*'([^']+)'/,
    /"channelId"\s*:\s*'([^']+)'/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function normalizeDiscordTargetCandidate(
  value: any,
  defaultKind?: "channel" | "user"
): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^slash:/i.test(raw)) return "";

  const mentionUser = raw.match(/^<@!?(\d+)>$/);
  if (mentionUser?.[1]) return `user:${mentionUser[1]}`;
  const mentionChannel = raw.match(/^<#(\d+)>$/);
  if (mentionChannel?.[1]) return `channel:${mentionChannel[1]}`;

  const discordScoped = raw.match(/^discord:(.+)$/i);
  const scoped = discordScoped?.[1]?.trim() || raw;

  const typed = scoped.match(/^(user|channel):(\d+)$/i);
  if (typed?.[1] && typed?.[2]) {
    return `${typed[1].toLowerCase()}:${typed[2]}`;
  }

  if (/^\d+$/.test(scoped) && defaultKind) {
    return `${defaultKind}:${scoped}`;
  }
  return "";
}

function resolveDiscordMessageTarget(ctx: any): string {
  const channelCandidates = [
    ctx.chatId,
    ctx.chat_id,
    ctx.channelTarget,
    ctx.channel_id,
    ctx.threadId,
    ctx.thread_id,
  ];
  for (const candidate of channelCandidates) {
    const normalized = normalizeDiscordTargetCandidate(candidate, "channel");
    if (normalized) return normalized;
  }

  // `to` on Discord slash invocations is often not a routable channel id.
  // Accept it only when it is explicitly typed (user:/channel:) or mention-like.
  const explicitTo = normalizeDiscordTargetCandidate(ctx.to);
  if (explicitTo) return explicitTo;

  const userCandidates = [
    ctx.from,
    ctx.senderId,
  ];
  for (const candidate of userCandidates) {
    const normalized = normalizeDiscordTargetCandidate(candidate, "user");
    if (normalized) return normalized;
  }
  return "";
}

function resolveMessageTarget(ctx: any): string {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  if (channel === "feishu") {
    return String(
      ctx.chatId || ctx.chat_id || ctx.to || ctx.from || ctx.senderId || ""
    ).trim();
  }
  if (channel === "discord") {
    return resolveDiscordMessageTarget(ctx);
  }
  return String(ctx.to || ctx.from || ctx.senderId || "").trim();
}

function canPushLuckeeUpdates(ctx?: any): boolean {
  if (!ctx) return false;
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = resolveMessageTarget(ctx);
  if (!channel || !target || !PUSH_CAPABLE_CHANNELS.has(channel)) return false;
  if (channel === "feishu" && !resolveFeishuReceiveId(ctx)) return false;
  return true;
}

function buildMessageArgs(ctx: any, text: string, targetOverride?: string): string[] {
  const channel = String(ctx.channelId || ctx.channel || "").trim();
  const target = String(targetOverride || resolveMessageTarget(ctx)).trim();
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

function sanitizeFeishuCardText(text: string): string {
  return String(text || "").replace(/```/g, "``\\`");
}

function renderTerminalOutputText(text: string): string {
  const raw = String(text || "");
  if (!raw.trim()) return "(empty output)";
  try {
    const terminal = new Terminal();
    terminal.write(raw);
    const rendered = stripAnsi(String(terminal.ansi || ""))
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return rendered || "(empty output)";
  } catch {
    const fallback = stripAnsi(raw)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return fallback || "(empty output)";
  }
}

function renderLuckeeUserFacingText(text: string): string {
  return normalizeWrappedUrls(renderTerminalOutputText(text));
}

function buildFeishuCardMarkdownElementsWithMirror(text: string): {
  elements: Array<Record<string, any>>;
  plainTextMirror: string;
} {
  const rendered = sanitizeFeishuCardText(renderTerminalOutputText(text));
  const { body, status } = extractStatusFooter(rendered);
  const content = body.trim() || "(empty output)";
  const chunks = splitChunks(content, FEISHU_CARD_CHUNK_SIZE);
  const markdownBlocks: Array<Record<string, any>> = chunks.map((chunk, idx) => {
    const total = chunks.length;
    const prefix = total > 1 ? `Part ${idx + 1}/${total}\n` : "";
    return {
      tag: "markdown",
      content: `${prefix}${chunk}`,
    };
  });
  if (status) {
    markdownBlocks.push({
      tag: "hr",
    });
    markdownBlocks.push({
      tag: "markdown",
      content: status,
    });
  }

  const bodyMirror = chunks
    .map((chunk, idx) => {
      const total = chunks.length;
      const prefix = total > 1 ? `Part ${idx + 1}/${total}\n` : "";
      return `${prefix}${chunk}`;
    })
    .join("\n\n");
  const plainTextMirror = status ? `${bodyMirror}\n\n---\n\n${status}` : bodyMirror;

  return { elements: markdownBlocks, plainTextMirror };
}

function buildFeishuCardMarkdownElements(text: string): Array<Record<string, any>> {
  return buildFeishuCardMarkdownElementsWithMirror(text).elements;
}

/** Plain text matching Feishu card markdown + status layout for the same source string passed to the native card API. */
function feishuPlainTextFromCardSourceText(text: string): string {
  return buildFeishuCardMarkdownElementsWithMirror(text).plainTextMirror;
}

/**
 * Same segments and source strings as sendFeishuFullOutputFromTemp, concatenated so the agent sees what users see on the final card(s).
 */
function feishuToolPlainTextMirroringFinalCards(rawCliOutput: string): string {
  const stripped = stripLuckeeGeneratedFileLines(
    String(rawCliOutput || "").trim() || "(luckee completed with empty output)"
  );
  const normalized = normalizeWrappedUrls(
    stripped || "(luckee completed with empty output)"
  );
  const persisted = normalized;
  const parts = splitChunks(
    persisted || "(luckee completed with empty output)",
    FEISHU_FINAL_OUTPUT_PART_SIZE
  );
  const segmentMirrors: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const prefix = parts.length > 1 ? `完整输出 ${i + 1}/${parts.length}\n\n` : "";
    const body = `${prefix}${parts[i]}`;
    const text = isLast ? withDoneFooter(body) : body;
    segmentMirrors.push(feishuPlainTextFromCardSourceText(text));
  }
  return segmentMirrors.join("\n\n----------\n\n");
}

/** Text returned to the agent as the tool result: Feishu card mirror, else same as final normal-chat message (rendered + completed footer). */
function luckeeToolFacingResultForAgent(rawCliOutput: string, channel: string): string {
  if (String(channel).trim() === "feishu") {
    return feishuToolPlainTextMirroringFinalCards(rawCliOutput);
  }
  return withDoneFooter(renderLuckeeUserFacingText(rawCliOutput));
}

function buildFeishuCard(text: string, options: FeishuCardOptions = {}): Record<string, any> {
  const markdownElements = buildFeishuCardMarkdownElementsWithMirror(text).elements;
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
        content: options.title ? `Luckee: ${options.title}` : "Luckee",
      },
      template: "blue",
    },
    body: {
      elements: [
        ...markdownElements,
        //stopButton,
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
  let out = id;
  if (out.startsWith("feishu:") || out.startsWith("lark:")) {
    out = out.replace(/^(?:feishu|lark):/i, "");
  }
  out = out.replace(/^(?:chat|group|channel|user|dm|open_id):/i, "");
  return out;
}

function resolveFeishuReceiveId(ctx: any): { receiveId: string; receiveIdType: string } | null {
  const rawTo = String(ctx.to || "").trim();
  const rawFrom = String(ctx.from || ctx.senderId || "").trim();
  const chatId = String(ctx.chatId || ctx.chat_id || "").trim();

  const candidates = [chatId, rawTo, rawFrom]
    .map((v) => stripFeishuPrefix(v))
    .filter((id) => Boolean(id) && !isPlaceholderToolActorId(id));

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
    let editTarget = target;
    if (channel === "discord") {
      editTarget =
        discordMessageChannelTargetById.get(prevMessageId) ||
        (target.startsWith("channel:") ? target : "");
      if (!editTarget) {
        api.logger?.warn?.(
          `[luckee] edit skipped for discord messageId=${prevMessageId}: missing channel target`
        );
        return { ok: false, messageId: prevMessageId, edited: false };
      }
    }
    const editArgs = [
      "message",
      "edit",
      ...buildMessageArgs(ctx, text, editTarget),
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
  if (channel === "discord" && messageId) {
    const payloadChannelId =
      extractChannelId(payload) ||
      extractChannelIdFromRaw(result.stdout) ||
      extractChannelIdFromRaw(result.stderr);
    const normalizedPayloadTarget = normalizeDiscordTargetCandidate(
      payloadChannelId,
      "channel"
    );
    const knownTarget = target.startsWith("channel:") ? target : "";
    const resolvedChannelTarget = normalizedPayloadTarget || knownTarget;
    if (resolvedChannelTarget) {
      discordMessageChannelTargetById.set(messageId, resolvedChannelTarget);
      api.logger?.info?.(
        `[luckee] cached discord message target: messageId=${messageId} target=${resolvedChannelTarget}`
      );
    }
  }
  api.logger?.info?.(
    `[luckee] openclaw send ok: channel=${channel} messageId=${messageId || "none"}`
  );
  return { ok: true, messageId, edited: false };
}

function createLuckeeTempOutputPath(prefix = "luckee-feishu-output"): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${suffix}.log`);
}

/** True if path looks like ``~/.luckee/<thread_id>/generated_files/<file>`` (resolved). */
function isAllowedLuckeeArtifactPath(absPath: string): boolean {
  const n = path.normalize(absPath);
  const marker = `${path.sep}.luckee${path.sep}`;
  const gen = `${path.sep}generated_files${path.sep}`;
  return n.includes(marker) && n.includes(gen);
}

/** Strip machine-only lines emitted by luckee CLI for OpenClaw file extraction. */
function stripLuckeeGeneratedFileLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((ln) => !/^Generated a file:\s/.test(ln.trim()));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse absolute artifact paths from luckee CLI stdout (must match
 * core_agent_loop ``format_generated_line`` / ``~/.luckee/<thread>/generated_files/``).
 */
function collectLuckeeArtifactAbsolutePaths(rawOutput: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /^Generated a file:\s.+\s\(([^)]+)\)\s*$/;
  for (const line of String(rawOutput || "").split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (!m) continue;
    const p = m[1];
    if (!isAllowedLuckeeArtifactPath(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

async function feishuImUploadFileBytes(
  api: any,
  token: string,
  fileName: string,
  bytes: Buffer
): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("file_type", "stream");
    form.append("file_name", fileName);
    form.append("file", new Blob([bytes]), fileName);
    const res = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const bodyText = await res.text();
    let data: any = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = null;
    }
    if (res.ok && data?.code === 0 && data?.data?.file_key) {
      return String(data.data.file_key);
    }
    api.logger?.warn?.(
      `[luckee] feishu im/files upload failed status=${res.status} body=${(bodyText || "").slice(0, 400)}`
    );
  } catch (err: any) {
    api.logger?.warn?.(`[luckee] feishu im/files upload error: ${String(err?.message || err)}`);
  }
  return null;
}

async function feishuImReplyFileKey(
  api: any,
  token: string,
  parentMessageId: string,
  fileKey: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(
        parentMessageId
      )}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msg_type: "file",
          content: JSON.stringify({ file_key: fileKey }),
        }),
      }
    );
    const bodyText = await res.text();
    let data: any = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = null;
    }
    if (!res.ok || data?.code !== 0) {
      api.logger?.warn?.(
        `[luckee] feishu file reply failed status=${res.status} body=${(bodyText || "").slice(0, 400)}`
      );
      return false;
    }
    return true;
  } catch (err: any) {
    api.logger?.warn?.(`[luckee] feishu file reply error: ${String(err?.message || err)}`);
    return false;
  }
}

/** Upload each ``~/.luckee/.../generated_files/`` artifact as a Feishu chat file, in order. */
async function uploadLuckeeCliArtifactsToFeishu(
  api: any,
  ctx: any,
  parentMessageId: string | undefined,
  rawCliOutput: string
): Promise<void> {
  const paths = collectLuckeeArtifactAbsolutePaths(rawCliOutput);
  if (!paths.length) return;
  const token = await getFeishuTenantToken(api);
  if (!token) {
    api.logger?.warn?.("[luckee] feishu artifact upload: missing tenant token");
    return;
  }
  const parent = String(parentMessageId || "").trim();
  if (!parent) {
    api.logger?.warn?.("[luckee] feishu artifact upload: missing parent message id");
    return;
  }
  for (const absPath of paths) {
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        api.logger?.warn?.(`[luckee] feishu artifact upload: not a file: ${absPath}`);
        continue;
      }
      const bytes = await fs.readFile(absPath);
      const fileName = path.basename(absPath) || "luckee-artifact.bin";
      const fileKey = await feishuImUploadFileBytes(api, token, fileName, bytes);
      if (!fileKey) continue;
      const ok = await feishuImReplyFileKey(api, token, parent, fileKey);
      api.logger?.info?.(
        `[luckee] feishu artifact ${ok ? "sent" : "failed"}: ${fileName} (${bytes.length} B)`
      );
    } catch (err: any) {
      api.logger?.warn?.(
        `[luckee] feishu artifact upload error path=${absPath} err=${String(err?.message || err)}`
      );
    }
  }
}

async function sendFeishuFullOutputFromTemp(
  api: any,
  ctx: any,
  fullText: string,
  prevMessageId?: string,
  options: FeishuCardOptions = {}
): Promise<{ ok: boolean; messageId?: string; tempPath?: string }> {
  const tempPath = createLuckeeTempOutputPath();
  const stripped = stripLuckeeGeneratedFileLines(
    String(fullText || "").trim() || "(luckee completed with empty output)"
  );
  const normalized = normalizeWrappedUrls(
    stripped || "(luckee completed with empty output)"
  );

  try {
    await fs.writeFile(tempPath, normalized, "utf8");
    const persisted = await fs.readFile(tempPath, "utf8");
    const parts = splitChunks(
      persisted || "(luckee completed with empty output)",
      FEISHU_FINAL_OUTPUT_PART_SIZE
    );

    let latestMessageId = prevMessageId;
    let allOk = true;
    for (let i = 0; i < parts.length; i++) {
      const isFirst = i === 0;
      const isLast = i === parts.length - 1;
      const prefix = parts.length > 1 ? `完整输出 ${i + 1}/${parts.length}\n\n` : "";
      const body = `${prefix}${parts[i]}`;
      const text = isLast ? withDoneFooter(body) : body;
      const result = await sendProgressMessageEditable(
        api,
        ctx,
        text,
        isFirst ? latestMessageId : undefined,
        {
          stopButtonDisabled: true,
          stopButtonText: options.stopButtonText || "Query Completed",
          title: options.title,
        }
      );
      allOk = allOk && result.ok;
      if (result.ok && result.messageId) {
        latestMessageId = result.messageId;
      }
    }

    api.logger?.info?.(
      `[luckee] feishu full-output sent via temp file: path=${tempPath} chars=${persisted.length} parts=${parts.length}`
    );
    return { ok: allOk, messageId: latestMessageId, tempPath };
  } catch (err: any) {
    api.logger?.warn?.(
      `[luckee] feishu full-output temp send failed: path=${tempPath} error=${String(err?.message || err)}`
    );
    return { ok: false, messageId: prevMessageId, tempPath };
  }
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
  appendStoppedFooter: boolean,
  title?: string
): Promise<void> {
  const trackedCard = activeFeishuProgressCards.get(processKey);
  const messageId = trackedCard?.messageId || extractFeishuMessageId(ctx);
  if (!messageId) return;
  const baseText = stripStatusFooter(trackedCard?.text || fallbackText || "当前查询已停止。");
  const nextText = appendStoppedFooter
    ? buildStoppedCardText(baseText, fallbackText)
    : (String(fallbackText || "").trim() || baseText);
  const ok = await updateFeishuCardNative(api, messageId, nextText, {
    stopButtonDisabled: true,
    stopButtonText: buttonText,
    title,
  });
  if (ok) {
    forgetActiveFeishuProgressCard(processKey, trackedCard?.messageId || messageId);
  }
}

async function handleLuckeeStop(api: any, ctx?: any): Promise<string> {
  const processKey = ctx ? getSenderKey(ctx) : "";
  const channel = String(ctx?.channelId || ctx?.channel || "").trim();
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
  const stopTitle = stopped.query ? safePreview(stopped.query, 60) : undefined;
  if (processKey && channel !== "feishu") {
    const progressMessageId = activeProgressMessageIds.get(processKey);
    if (progressMessageId) {
      const result = await sendProgressMessageEditable(
        api,
        ctx,
        withStoppedFooter(text),
        progressMessageId,
        {
          stopButtonDisabled: true,
          stopButtonText: stopped.stopped ? "Query Stopped" : "No Active Query",
          title: stopTitle,
        }
      );
      if (result.ok) {
        forgetActiveProgressMessageId(processKey, progressMessageId);
      }
    }
  }
  if (processKey && channel === "feishu") {
    await disableFeishuStopButton(
      api,
      processKey,
      ctx,
      text,
      stopped.stopped ? "Query Stopped" : "No Active Query",
      stopped.stopped,
      stopTitle
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

async function executeLuckeeControlAction(
  api: any,
  action: "login" | "logout",
  ctx?: any,
  origin: "tool" | "command" = "command"
): Promise<LuckeeControlResult> {
  const channel = ctx ? String(ctx.channelId || ctx.channel || "").trim() : "";
  const canPush = canPushLuckeeUpdates(ctx);
  const runtimeCfg: LuckeeConfig =
    api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
  const binaryPath = await resolveLuckeeBinaryOrThrow(api, runtimeCfg);
  const args = [action];
  const senderKey = ctx ? getSenderKey(ctx) : "";
  const commandLabel = `luckee ${action}`;

  logLuckeeInvocation(api, origin, {
    action,
    channel,
    streaming: canPush,
  });
  api.logger?.info?.(`[luckee] ${origin} resolved binary: ${binaryPath}`);
  api.logger?.info?.(`[luckee] ${origin} cli args: ${JSON.stringify(args)}`);

  if (!canPush) {
    const abortHandle: AbortHandle = {
      stopRequested: false,
      kill: () => {
        abortHandle.stopRequested = true;
      },
    };
    if (senderKey) {
      const interruptedExisting = stopTrackedProcess(senderKey);
      if (interruptedExisting.stopped) {
        api.logger?.info?.(
          `[luckee] ${origin} interrupted prior ${interruptedExisting.kind || "process"} for sender=${hashSenderKey(senderKey).slice(0, 8)} query="${safePreview(interruptedExisting.query || "", 80)}"`
        );
      }
      activeProcesses.set(senderKey, { kill: () => abortHandle.kill(), query: action });
    }
    try {
      const output = await runCommand(
        binaryPath,
        args,
        senderKey ? abortHandle : undefined,
        (stream, chunk) => logLuckeeCliChunk(api, origin, stream, chunk)
      );
      return {
        kind: "done",
        output: renderLuckeeUserFacingText(output),
        usedPush: false,
      };
    } catch (err: any) {
      if (isLuckeeStoppedError(err)) {
        return {
          kind: "stopped",
          output: `已停止执行 \`${commandLabel}\`。`,
          usedPush: false,
        };
      }
      throw err;
    } finally {
      if (senderKey) {
        activeProcesses.delete(senderKey);
      }
    }
  }

  const processKey = senderKey;
  const abortHandle: AbortHandle = {
    stopRequested: false,
    kill: () => {
      abortHandle.stopRequested = true;
    },
  };
  const interruptedExisting = stopTrackedProcess(processKey);
  if (interruptedExisting.stopped) {
    api.logger?.info?.(
      `[luckee] ${origin} interrupted prior ${interruptedExisting.kind || "process"} for sender=${hashSenderKey(processKey).slice(0, 8)} query="${safePreview(interruptedExisting.query || "", 80)}"`
    );
  }

  const flushEveryMs = Math.max(300, Number(runtimeCfg.streamFlushMs ?? 1000));
  let progressMessageId: string | undefined;
  let accumulated = "";
  let loadingTick = 0;
  let lastProgressDisplayText = "";
  const controlTitle = commandLabel;
  const initText = `🔄 正在执行: \`${commandLabel}\`\n\n请稍候...`;
  const initResult = await sendProgressMessageEditable(api, ctx, initText, undefined, { title: controlTitle });
  if (initResult.ok && initResult.messageId) {
    progressMessageId = initResult.messageId;
    rememberActiveFeishuProgressCard(processKey, initResult.messageId, initText);
    rememberActiveProgressMessageId(processKey, initResult.messageId);
    lastProgressDisplayText = initText;
  }
  activeProcesses.set(processKey, { kill: () => abortHandle.kill(), query: action });

  const pushProgress = async (chunk?: string) => {
    if (abortHandle.stopRequested) return;
    if (chunk) {
      accumulated = accumulated ? `${accumulated}${chunk}` : chunk;
    }
    const displayText = accumulated
      ? renderLuckeeUserFacingText(accumulated)
      : `🔄 正在执行: \`${commandLabel}\`\n\n请稍候...`;
    if (displayText === lastProgressDisplayText) {
      return;
    }
    const progressText = withProgressFooter(displayText, loadingTick);
    loadingTick += 1;
    const edited = await sendProgressMessageEditable(api, ctx, progressText, progressMessageId, { title: controlTitle });
    if (edited.ok) {
      progressMessageId = edited.messageId || progressMessageId;
      rememberActiveFeishuProgressCard(processKey, progressMessageId, progressText);
      rememberActiveProgressMessageId(processKey, progressMessageId);
      lastProgressDisplayText = displayText;
    }
  };

  try {
    const output = await runCommandStreaming(
      binaryPath,
      args,
      async (chunk) => pushProgress(chunk),
      flushEveryMs,
      async () => pushProgress(),
      abortHandle,
      (stream, chunk) => logLuckeeCliChunk(api, origin, stream, chunk)
    );
    const finalText = renderLuckeeUserFacingText(output);
    if (channel === "feishu") {
      const delivered = await sendFeishuFullOutputFromTemp(
        api,
        ctx,
        finalText,
        progressMessageId,
        {
          stopButtonDisabled: true,
          stopButtonText: action === "login" ? "Login Complete" : "Logout Complete",
          title: controlTitle,
        }
      );
      if (delivered.ok && delivered.messageId) {
        progressMessageId = delivered.messageId;
        rememberActiveProgressMessageId(processKey, progressMessageId);
      }
      const attachParent =
        delivered.ok && delivered.messageId ? delivered.messageId : progressMessageId;
      await uploadLuckeeCliArtifactsToFeishu(api, ctx, attachParent, output);
    } else {
      const edited = await sendProgressMessageEditable(api, ctx, finalText, progressMessageId, { title: controlTitle });
      if (edited.ok) {
        progressMessageId = edited.messageId || progressMessageId;
        rememberActiveProgressMessageId(processKey, progressMessageId);
      }
    }
    forgetActiveProgressMessageId(processKey, progressMessageId);
    forgetActiveFeishuProgressCard(processKey, progressMessageId);
    return { kind: "done", output: finalText, usedPush: true };
  } catch (err: any) {
    if (isLuckeeStoppedError(err)) {
      const stoppedText = `已停止执行 \`${commandLabel}\`。`;
      if (channel === "feishu") {
        await disableFeishuStopButton(
          api,
          processKey,
          ctx,
          stoppedText,
          "Stopped",
          false,
          controlTitle
        );
      } else {
        await sendProgressMessageEditable(api, ctx, stoppedText, progressMessageId, { title: controlTitle });
      }
      forgetActiveProgressMessageId(processKey, progressMessageId);
      forgetActiveFeishuProgressCard(processKey, progressMessageId);
      return { kind: "stopped", output: stoppedText, usedPush: true };
    }
    throw err;
  } finally {
    forgetActiveProgressMessageId(processKey);
    activeProcesses.delete(processKey);
  }
}

function buildLuckeeUsageMessage(): string {
  return (
    "Usage:\n" +
    "`/luckee <query>`\n" +
    "`/luckee login`\n" +
    "`/luckee logout`\n" +
    "`/luckee token <your_token>`\n" +
    "`/luckee token <your_token> <query>`\n" +
    "`/luckee stop`"
  );
}

function parseLuckeeCommandArgs(rawArgs: string): {
  action: LuckeeCommandAction;
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

  if (/^login$/i.test(trimmed)) {
    return { action: "login" };
  }

  if (/^logout$/i.test(trimmed)) {
    return { action: "logout" };
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

  const authTitle = safePreview(query, 60);

  const updateCard = async (text: string, options: FeishuCardOptions = {}) => {
    const currentSession = authWaitSessions.get(processKey);
    if (!currentSession || currentSession.id !== sessionId) return;
    const currentMessageId = getProgressMessageId();
    if (!currentMessageId) return;
    const mergedOptions = { title: authTitle, ...options };
    const result = await sendProgressMessageEditable(api, ctx, text, currentMessageId, mergedOptions);
    if (result.ok && result.messageId) {
      setProgressMessageId(result.messageId);
      rememberActiveFeishuProgressCard(processKey, result.messageId, text);
      rememberActiveProgressMessageId(processKey, result.messageId);
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
      const channel = String(ctx?.channelId || ctx?.channel || "").trim();
      if (channel === "feishu") {
        const delivered = await sendFeishuFullOutputFromTemp(
          api,
          ctx,
          output,
          getProgressMessageId(),
          { stopButtonDisabled: true, stopButtonText: "Query Completed", title: authTitle }
        );
        if (delivered.ok && delivered.messageId) {
          setProgressMessageId(delivered.messageId);
          rememberActiveProgressMessageId(processKey, delivered.messageId);
        }
        const attachParent =
          delivered.ok && delivered.messageId ? delivered.messageId : getProgressMessageId();
        await uploadLuckeeCliArtifactsToFeishu(api, ctx, attachParent, output);
      } else {
        await updateCard(
          withDoneFooter(renderLuckeeUserFacingText(output)),
          { stopButtonDisabled: true, stopButtonText: "Query Completed" }
        );
      }
      authWaitSessions.delete(processKey);
      forgetActiveProgressMessageId(processKey, getProgressMessageId());
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
      forgetActiveProgressMessageId(processKey, getProgressMessageId());
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
  const canPush = canPushLuckeeUpdates(ctx);
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
    try {
      const output = await executeLuckee(api, {
        ...params,
        token: effectiveToken,
        origin,
        ctx,
        persistProvidedToken:
          origin === "tool" && Boolean(params?.token && String(params.token).trim()),
      });
      const doneOutput = luckeeToolFacingResultForAgent(output, channel);
      api.logger?.info?.(
        `[luckee] ${origin} success: query="${safePreview(query)}" outputChars=${output.length}`
      );
      return { kind: "done", output: doneOutput, usedPush: false };
    } catch (err: any) {
      if (isLuckeeStoppedError(err)) {
        api.logger?.info?.(
          `[luckee] ${origin} stopped: query="${safePreview(query)}"`
        );
        return { kind: "stopped", output: `已停止查询: ${safePreview(query, 50)}`, usedPush: false };
      }
      throw err;
    }
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

    const { cfg, args, effectiveTimeoutSeconds } = resolveLuckeeInvocation(api, {
      ...params,
      token: effectiveToken,
    });
    logLuckeeInvocation(api, origin, {
      query: safePreview(query),
      hasToken: Boolean(effectiveToken),
      token: redactToken(String(effectiveToken || "")),
      channel,
      streaming: true,
      timeoutRequested: params.timeout ?? null,
      timeoutSecondsEffective: effectiveTimeoutSeconds,
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
    let lastProgressDisplayText = "";
    let loginDetected = false;
    const processKey = senderKey;
    const abortHandle: AbortHandle = {
      stopRequested: false,
      kill: () => {
        abortHandle.stopRequested = true;
      },
    };
    const cardTitle = safePreview(query, 60);
    const initText = `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
    const initResult = await sendProgressMessageEditable(api, ctx, initText, undefined, { title: cardTitle });
    if (initResult.ok && initResult.messageId) {
      progressMessageId = initResult.messageId;
      rememberActiveFeishuProgressCard(processKey, initResult.messageId, initText);
      rememberActiveProgressMessageId(processKey, initResult.messageId);
      lastProgressDisplayText = initText;
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
      if (abortHandle.stopRequested) return;
      if (loginDetected) return;
      if (chunk) {
        accumulated = accumulated ? `${accumulated}${chunk}` : chunk;
      }
      if (!accumulated && !progressMessageId) return;

      if (detectLoginRequired(accumulated)) {
        loginDetected = true;
        const authUrl = extractAuthUrl(accumulated);
        const loginResult = await sendProgressMessageEditable(
          api,
          ctx,
          buildLoginRequiredMessage(authUrl),
          progressMessageId,
          { title: cardTitle }
        );
        if (loginResult.ok) {
          progressMessageId = loginResult.messageId || progressMessageId;
          rememberActiveFeishuProgressCard(processKey, progressMessageId, buildLoginRequiredMessage(authUrl));
          rememberActiveProgressMessageId(processKey, progressMessageId);
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
        ? renderLuckeeUserFacingText(accumulated)
        : `🔄 正在处理: \`${safePreview(query, 80)}\`\n\n请稍候...`;
      if (displayText === lastProgressDisplayText) {
        return;
      }
      const progressText = withProgressFooter(displayText, loadingTick);
      loadingTick += 1;

      const edited = await sendProgressMessageEditable(
        api, ctx, progressText, progressMessageId, { title: cardTitle }
      );
      if (edited.ok) {
        progressMessageId = edited.messageId || progressMessageId;
        rememberActiveFeishuProgressCard(processKey, progressMessageId, progressText);
        rememberActiveProgressMessageId(processKey, progressMessageId);
        lastProgressDisplayText = displayText;
      }
    };

    try {
      const runPromise = runCommandStreaming(
        binaryPath,
        args,
        async (chunk) => pushProgress(chunk),
        flushEveryMs,
        async () => pushProgress(),
        abortHandle,
        (stream, chunk) => logLuckeeCliChunk(api, origin, stream, chunk)
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
        if (isLuckeeStoppedError(result.error)) {
          const stoppedText = `已停止查询: ${safePreview(query, 50)}`;
          if (channel === "feishu") {
            await disableFeishuStopButton(
              api,
              processKey,
              ctx,
              stoppedText,
              "Query Stopped",
              true,
              cardTitle
            );
          } else {
            await sendProgressMessageEditable(
              api,
              ctx,
              withStoppedFooter(stoppedText),
              progressMessageId,
              {
                stopButtonDisabled: true,
                stopButtonText: "Query Stopped",
                title: cardTitle,
              }
            );
          }
          api.logger?.info?.(
            `[luckee] ${origin} stopped(streamed): query="${safePreview(query)}"`
          );
          forgetActiveProgressMessageId(processKey, progressMessageId);
          return { kind: "stopped", output: stoppedText, usedPush: true };
        }
        throw result.error;
      }

      const output = result.output;

      if (progressMessageId) {
        if (channel === "feishu") {
          const delivered = await sendFeishuFullOutputFromTemp(
            api,
            ctx,
            output,
            progressMessageId,
            { stopButtonDisabled: true, stopButtonText: "Query Completed", title: cardTitle }
          );
          if (delivered.ok && delivered.messageId) {
            progressMessageId = delivered.messageId;
            rememberActiveProgressMessageId(processKey, progressMessageId);
          }
          const attachParent =
            delivered.ok && delivered.messageId ? delivered.messageId : progressMessageId;
          await uploadLuckeeCliArtifactsToFeishu(api, ctx, attachParent, output);
        } else {
          const finalText = withDoneFooter(
            renderLuckeeUserFacingText(output)
          );
          const finalResult = await sendProgressMessageEditable(api, ctx, finalText, progressMessageId, {
            stopButtonDisabled: true,
            stopButtonText: "Query Completed",
            title: cardTitle,
          });
          if (finalResult.ok && finalResult.messageId) {
            progressMessageId = finalResult.messageId;
            rememberActiveProgressMessageId(processKey, progressMessageId);
          }
        }
        forgetActiveProgressMessageId(processKey, progressMessageId);
        forgetActiveFeishuProgressCard(processKey, progressMessageId);
      }

      const doneOutput = luckeeToolFacingResultForAgent(output, channel);
      api.logger?.info?.(
        `[luckee] ${origin} success(streamed): query="${safePreview(query)}" outputChars=${output.length}`
      );
      return { kind: "done", output: doneOutput, usedPush: true };
    } finally {
      forgetActiveProgressMessageId(processKey);
      activeProcesses.delete(processKey);
    }
  } catch (err: any) {
    api.logger?.error?.(
      `[luckee] ${origin} failed: query="${safePreview(query)}" error=${String(err?.message || err)}`
    );
    throw err;
  }
}

function buildDetachedLuckeeStartMessage(query: string): string {
  return (
    `已开始处理 Luckee 查询: ${safePreview(query, 50)}\n` +
    "我会把进度和结果继续发到当前聊天。发送 `/luckee stop` 可随时停止。"
  );
}

async function startLuckeeInteractiveDetached(
  api: any,
  params: any,
  ctx: any,
  origin: "tool" | "command",
  tmpAttachmentPaths?: string[],
): Promise<string> {
  const query = String(params?.query ?? "").trim();
  void (async () => {
    try {
      await executeLuckeeInteractive(api, params, ctx, origin);
    } catch (err: any) {
      const errMsg = String(err?.message || err || "");
      const failText = `Luckee 查询失败: ${safePreview(errMsg, 200)}`;
      api.logger?.error?.(
        `[luckee] ${origin} detached failed: query="${safePreview(query)}" error=${safePreview(errMsg, 200)}`
      );
      try {
        await sendProgressMessageEditable(api, ctx, failText, undefined, { title: safePreview(query, 60) });
      } catch {
        // Best effort only.
      }
    } finally {
      if (tmpAttachmentPaths?.length) {
        for (const p of tmpAttachmentPaths) {
          await fs.unlink(p).catch(() => {});
        }
      }
    }
  })();
  return buildDetachedLuckeeStartMessage(query);
}

// ── Attachment helpers ────────────────────────────────────────────────────────

/**
 * Extract an attachment ref from a Feishu message_received event.
 * Feishu delivers file/image messages with file_key / image_key in the content.
 */
function extractFeishuAttachmentFromEvent(
  event: any,
  ctx: any,
): AttachmentRef | null {
  // The Feishu message_id is needed for the download API.
  const messageId = String(
    event.metadata?.messageId ||
    event.metadata?.open_message_id ||
    ctx.messageThreadId ||
    event.metadata?.threadId ||
    ""
  ).trim();
  if (!messageId) return null;

  // Parse message content (may be a raw JSON string from Feishu).
  const raw = event.content ?? event.metadata?.content ?? event.metadata?.rawContent;
  let content: Record<string, any> = {};
  if (raw) {
    try {
      content = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, any>);
    } catch {
      return null;
    }
  }

  if (content.file_key) {
    return {
      kind: "feishu_file",
      messageId,
      fileKey: String(content.file_key),
      fileType: "file",
      fileName: String(content.file_name || content.file_key || "attachment"),
    };
  }
  if (content.image_key) {
    return {
      kind: "feishu_file",
      messageId,
      fileKey: String(content.image_key),
      fileType: "image",
      fileName: "image.png",
    };
  }

  // Fallback: check event type field
  const msgType = String(event.type || event.metadata?.messageType || "").toLowerCase();
  if (msgType === "file" || msgType === "image" || msgType === "audio" || msgType === "video") {
    const key = String(content.file_key || content.image_key || content.audio_key || content.video_key || "");
    if (key) {
      return {
        kind: "feishu_file",
        messageId,
        fileKey: key,
        fileType: msgType as AttachmentRef["fileType"],
        fileName: String(content.file_name || key),
      };
    }
  }

  return null;
}

/** Extract generic URL-based attachments from event.attachments / event.files. */
function extractGenericAttachmentsFromEvent(event: any): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const list: any[] = event.attachments ?? event.files ?? [];
  if (!Array.isArray(list)) return refs;
  for (const att of list) {
    const url = String(att?.url || att?.download_url || att?.link || "").trim();
    const name = String(att?.name || att?.filename || att?.title || path.basename(url) || "attachment").trim();
    if (url) refs.push({ kind: "url", url, fileName: name });
  }
  return refs;
}

async function downloadFeishuFileToTemp(
  api: any,
  messageId: string,
  fileKey: string,
  fileType: "file" | "image" | "audio" | "video",
  fileName: string,
): Promise<string> {
  const token = await getFeishuTenantToken(api);
  if (!token) throw new Error("Feishu tenant token unavailable for file download");

  const resourceType = fileType === "image" ? "image" : "file";
  const url =
    `https://open.feishu.cn/open-apis/im/v1/messages/` +
    `${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}` +
    `?type=${resourceType}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Feishu file download HTTP ${res.status} key=${fileKey}`);
  }

  const safeBase = path.basename(fileName).replace(/[^\w.\-]/g, "_") || "attachment";
  const tmpPath = path.join(
    os.tmpdir(),
    `luckee-attach-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeBase}`
  );
  await fs.writeFile(tmpPath, Buffer.from(await res.arrayBuffer()));
  return tmpPath;
}

async function downloadUrlToTemp(url: string, fileName: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Attachment download HTTP ${res.status} from ${url}`);
  const safeBase = path.basename(fileName).replace(/[^\w.\-]/g, "_") || "attachment";
  const tmpPath = path.join(
    os.tmpdir(),
    `luckee-attach-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeBase}`
  );
  await fs.writeFile(tmpPath, Buffer.from(await res.arrayBuffer()));
  return tmpPath;
}

/** Download all attachment refs to temp files; skips failed downloads with a warning. */
async function downloadAttachmentRefs(
  api: any,
  refs: AttachmentRef[],
  channelId: string,
): Promise<string[]> {
  const tmpPaths: string[] = [];
  for (const ref of refs) {
    try {
      if (ref.kind === "feishu_file") {
        const p = await downloadFeishuFileToTemp(api, ref.messageId, ref.fileKey, ref.fileType, ref.fileName);
        tmpPaths.push(p);
        api.logger?.info?.(`[luckee] downloaded feishu ${ref.fileType} key=${ref.fileKey} → ${p}`);
      } else if (ref.kind === "url") {
        const p = await downloadUrlToTemp(ref.url, ref.fileName);
        tmpPaths.push(p);
        api.logger?.info?.(`[luckee] downloaded url attachment → ${p}`);
      }
    } catch (err: any) {
      api.logger?.warn?.(
        `[luckee] attachment download failed (channel=${channelId}): ${String(err?.message || err)}`
      );
    }
  }
  return tmpPaths;
}

/**
 * Collect all pending attachment refs for a sender: from the current event/ctx
 * (same-message attachments) plus any previously cached refs from prior messages.
 */
function collectAttachmentRefs(
  event: any,
  ctx: any,
  channelId: string,
  senderKey: string,
): AttachmentRef[] {
  const refs: AttachmentRef[] = [];

  // Same-message attachments from current event (if available)
  if (event) {
    if (channelId === "feishu") {
      const feishuRef = extractFeishuAttachmentFromEvent(event, ctx);
      if (feishuRef) refs.push(feishuRef);
    }
    refs.push(...extractGenericAttachmentsFromEvent(event));
  }

  // Also check ctx.attachments / ctx.files (some platforms pass these directly)
  if (ctx) {
    refs.push(...extractGenericAttachmentsFromEvent(ctx));
  }

  // Pop any attachments cached from prior messages in this conversation
  refs.push(...popPendingAttachments(senderKey));

  return refs;
}

export default function register(api: any) {
  api.on("message_received", (event: any, ctx: any) => {
    try {
      cacheMessageCtx(ctx.channelId, ctx.accountId, event.from, {
        conversationId: ctx.conversationId,
        to: (event.metadata?.to as string) ?? undefined,
        threadId: (event.metadata?.threadId as string | number) ?? undefined,
      });

      // Cache any file/image attachments so the next /luckee command can use them.
      const channelId = String(ctx.channelId || "").trim();
      const senderKey = `${channelId}|${ctx.accountId || ""}|${event.from || ""}`;
      if (senderKey && channelId) {
        if (channelId === "feishu") {
          const ref = extractFeishuAttachmentFromEvent(event, ctx);
          if (ref) pushPendingAttachment(senderKey, ref);
        }
        for (const ref of extractGenericAttachmentsFromEvent(event)) {
          pushPendingAttachment(senderKey, ref);
        }
      }
    } catch {
      // best effort
    }
  });

  const luckeeQueryInputSchema = Type.Object({
    query: Type.String(),
    token: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    language: Type.Optional(Type.String()),
    timeout: Type.Optional(
      Type.Number({
        description:
          "Optional. Timeout in seconds; must be >= 1800 if set. Omit to use 1800s.",
      })
    ),
  });
  const luckeeSetTokenInputSchema = Type.Object({
    token: Type.String(),
  });
  const luckeeStopInputSchema = Type.Object({});

  api.registerCommand({
    name: "luckee",
    description: "Run Luckee queries directly from chat.",
    acceptsArgs: true,
    async handler(ctx: any) {
      cacheMessageCtx(
        ctx.channelId || ctx.channel,
        ctx.accountId,
        ctx.from || ctx.senderId || "",
        {
          conversationId: ctx.chatId || ctx.chat_id || ctx.to,
          to: ctx.to,
          threadId: ctx.messageThreadId,
        }
      );

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

      if (parsed.action === "login" || parsed.action === "logout") {
        const result = await executeLuckeeControlAction(
          api,
          parsed.action,
          ctx,
          "command"
        );
        if (result.kind === "stopped") {
          return result.usedPush ? {} : { text: result.output };
        }
        return result.usedPush ? {} : { text: result.output };
      }

      // Resolve sender key for attachment lookup (pop-on-consume from pending cache)
      const cmdChannelId = String(ctx.channelId || ctx.channel || "").trim();
      const cmdSenderKey = `${cmdChannelId}|${ctx.accountId || ""}|${ctx.from || ctx.senderId || ""}`;

      if (parsed.action === "token") {
        const token = String(parsed.token || "").trim();
        if (!token) {
          return { text: "Missing token.\n\n" + buildLuckeeUsageMessage() };
        }

        const savedText = await saveTokenForContext(api, runtimeCfg, token, ctx);
        if (!parsed.query) {
          return { text: savedText };
        }

        const tokenAttachRefs = collectAttachmentRefs(null, ctx, cmdChannelId, cmdSenderKey);
        const tokenTmpPaths = await downloadAttachmentRefs(api, tokenAttachRefs, cmdChannelId);

        if (canPushLuckeeUpdates(ctx)) {
          const text = await startLuckeeInteractiveDetached(
            api,
            { query: parsed.query, attachmentPaths: tokenTmpPaths },
            ctx,
            "command",
            tokenTmpPaths,
          );
          return { text };
        }

        try {
          const result = await executeLuckeeInteractive(
            api,
            { query: parsed.query, attachmentPaths: tokenTmpPaths },
            ctx,
            "command"
          );
          if (result.kind === "auth-pending") {
            return { text: result.message };
          }
          if (result.kind === "stopped") {
            return result.usedPush ? {} : { text: result.output };
          }
          return result.usedPush ? {} : { text: result.output };
        } finally {
          for (const p of tokenTmpPaths) { await fs.unlink(p).catch(() => {}); }
        }
      }

      const attachRefs = collectAttachmentRefs(null, ctx, cmdChannelId, cmdSenderKey);
      const tmpPaths = await downloadAttachmentRefs(api, attachRefs, cmdChannelId);

      if (canPushLuckeeUpdates(ctx)) {
        const text = await startLuckeeInteractiveDetached(
          api,
          { query: parsed.query, attachmentPaths: tmpPaths },
          ctx,
          "command",
          tmpPaths,
        );
        return { text };
      }

      try {
        const result = await executeLuckeeInteractive(
          api,
          { query: parsed.query, attachmentPaths: tmpPaths },
          ctx,
          "command"
        );
        if (result.kind === "auth-pending") {
          return { text: result.message };
        }
        if (result.kind === "stopped") {
          return result.usedPush ? {} : { text: result.output };
        }
        return result.usedPush ? {} : { text: result.output };
      } finally {
        for (const p of tmpPaths) { await fs.unlink(p).catch(() => {}); }
      }
    },
  });

  api.registerTool((toolCtx: any) => {
    const channelCtx = buildToolChannelCtx(toolCtx);
    api.logger?.info?.(
      `[luckee] luckee_query factory: messageChannel=${toolCtx?.messageChannel || "?"} sender=${toolCtx?.requesterSenderId || "?"} account=${toolCtx?.agentAccountId || "?"} cachedEntries=${lastMessageCtx.size} resolvedCtx=${channelCtx ? `ch=${channelCtx.channelId} target=${channelCtx.to} from=${channelCtx.from}` : "none"}`
    );
    return {
      name: "luckee_query",
      description:
        "Run a query through luckee CLI. `timeout` (seconds) must be >= 1800 if provided; omit it to use 1800s. Long queries may need a larger value.",
      parameters: luckeeQueryInputSchema,
      input: luckeeQueryInputSchema,
      async execute(_id: string, params: any) {
        const effectiveCtx = channelCtx;
        const queryPreview = safePreview(String(params?.query ?? ""), 200);
        const toolChannelId = String(effectiveCtx?.channelId || "").trim();
        const toolSenderKey = `${toolChannelId}|${effectiveCtx?.accountId || ""}|${effectiveCtx?.from || ""}`;
        const toolAttachRefs = collectAttachmentRefs(null, effectiveCtx, toolChannelId, toolSenderKey);
        const toolTmpPaths = await downloadAttachmentRefs(api, toolAttachRefs, toolChannelId);
        try {
          const result = await executeLuckeeInteractive(
            api,
            { ...params, attachmentPaths: toolTmpPaths },
            effectiveCtx,
            "tool"
          );
          const text =
            result.kind === "auth-pending" ? result.message : result.output;
          return result.kind === "auth-pending"
            ? luckeeToolReturnPending(text)
            : luckeeToolReturnSuccess(text);
        } catch (err: any) {
          api.logger?.error?.(
            `[luckee] luckee_query error: ${String(err?.message || err)}`
          );
          return luckeeToolReturnError(
            formatLuckeeQueryToolFailureMessage(err, queryPreview)
          );
        } finally {
          for (const p of toolTmpPaths) { await fs.unlink(p).catch(() => {}); }
        }
      },
    };
  });

  api.registerTool((toolCtx: any) => {
    const channelCtx = buildToolChannelCtx(toolCtx);
    return {
      name: "luckee_set_token",
      description:
        "Persist a Luckee token for the current chat sender. " +
        "Call this when the user provides `/luckee token <token>` or wants to save/update their token.",
      parameters: luckeeSetTokenInputSchema,
      input: luckeeSetTokenInputSchema,
      async execute(_id: string, params: any) {
        const token = String(params.token ?? "").trim();
        if (!token) {
          return luckeeToolReturnError("Missing token.");
        }

        const runtimeCfg: LuckeeConfig =
          api?.config?.plugins?.entries?.["luckee-tool"]?.config ?? {};
        return luckeeToolReturnSuccess(
          await saveTokenForContext(api, runtimeCfg, token, channelCtx)
        );
      },
    };
  });

  api.registerTool((toolCtx: any) => {
    const channelCtx = buildToolChannelCtx(toolCtx);
    return {
      name: "luckee_stop",
      description:
        "Stop a currently running luckee query. " +
        "Call this tool when the user wants to stop, cancel, or abort a running luckee query.",
      parameters: luckeeStopInputSchema,
      input: luckeeStopInputSchema,
      async execute(_id: string, _params: any) {
        const stopText = await handleLuckeeStop(api, channelCtx);
        return luckeeToolReturnSuccess(stopText);
      },
    };
  });
}
