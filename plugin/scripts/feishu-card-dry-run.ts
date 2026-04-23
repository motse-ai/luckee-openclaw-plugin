#!/usr/bin/env npx tsx
/**
 * Dry-run the same text pipeline the luckee-tool plugin uses before PATCHing a Feishu card.
 *
 * Logic is kept in sync with plugin/index.ts:
 *   stripLuckeeGeneratedFileLines → normalizeWrappedUrls → splitChunks(FEISHU_FINAL_OUTPUT_PART_SIZE)
 *   → withDoneFooter (last part) → buildFeishuCardMarkdownElementsWithMirror / buildFeishuCard
 *
 * Usage:
 *   cd plugin && npx tsx scripts/feishu-card-dry-run.ts -- /path/to/luckee --query "hi" --non-interactive ...
 *   cd plugin && npx tsx scripts/feishu-card-dry-run.ts --stdin < capture.log
 *   cd plugin && npx tsx scripts/feishu-card-dry-run.ts ./capture.log
 *
 * Env:
 *   LUCKEE_TITLE  optional card title (default: dry-run)
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { stdin as inputStdin, argv, env, exit } from "node:process";
import { text } from "node:stream/consumers";
import stripAnsi from "strip-ansi";

/** Keep in sync with index.ts */
const FEISHU_CARD_CHUNK_SIZE = 2400;
const FEISHU_FINAL_OUTPUT_PART_SIZE = Number.POSITIVE_INFINITY;

function splitChunks(text: string, maxLen = 900): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function normalizeWrappedUrls(t: string): string {
  if (!t) return t;
  let out = t;
  const wrappedUrlBoundary =
    /((?:https?:\/\/)[^\s\n]+)\n(?=[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%])/g;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(wrappedUrlBoundary, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

function withDoneFooter(s: string): string {
  return `${s}\n\n---\n✅ Completed`;
}

function extractStatusFooter(text: string): { body: string; status?: string } {
  const raw = String(text || "");
  const match = raw.match(/\n\n---\n(⏳ Still loading\.{1,3}|✅ Completed|⏹️ Stopped)\s*$/s);
  if (!match) return { body: raw };
  const status = String(match[1] || "").trim();
  const body = raw.slice(0, match.index).trimEnd();
  return { body, status };
}

function sanitizeFeishuCardText(text: string): string {
  return String(text || "").replace(/```/g, "``\\`");
}

function renderTerminalOutputText(text: string): string {
  let raw = String(text || "");
  if (!raw.trim()) return "(empty output)";
  raw = stripAnsi(raw)
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\u001b[DM]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return raw || "(empty output)";
}

function stripLuckeeGeneratedFileLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((ln) => !/^Generated a file:\s/.test(ln.trim()));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildFeishuCardMarkdownElementsWithMirror(text: string): {
  elements: Array<Record<string, unknown>>;
  plainTextMirror: string;
} {
  const rendered = sanitizeFeishuCardText(renderTerminalOutputText(text));
  const { body, status } = extractStatusFooter(rendered);
  const content = body.trim() || "(empty output)";
  const chunks = splitChunks(content, FEISHU_CARD_CHUNK_SIZE);
  const markdownBlocks: Array<Record<string, unknown>> = chunks.map((chunk, idx) => {
    const total = chunks.length;
    const prefix = total > 1 ? `Part ${idx + 1}/${total}\n` : "";
    return { tag: "markdown", content: `${prefix}${chunk}` };
  });
  if (status) {
    markdownBlocks.push({ tag: "hr" });
    markdownBlocks.push({ tag: "markdown", content: status });
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

function buildFeishuCard(text: string, title?: string): Record<string, unknown> {
  const markdownElements = buildFeishuCardMarkdownElementsWithMirror(text).elements;
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: title ? `Luckee: ${title}` : "Luckee",
      },
      template: "blue",
    },
    body: { elements: markdownElements },
  };
}

/** Same as sendFeishuFullOutputFromTemp body for a single final segment (typical one-shot query). */
function pipelineFinalCardPayload(rawStdout: string, cardTitle: string): Record<string, unknown> {
  const stripped =
    stripLuckeeGeneratedFileLines(String(rawStdout || "").trim() || "(luckee completed with empty output)") ||
    "(luckee completed with empty output)";
  const normalized = normalizeWrappedUrls(stripped);
  const parts = splitChunks(normalized, FEISHU_FINAL_OUTPUT_PART_SIZE);
  const lastPart = parts[parts.length - 1] ?? normalized;
  const text = withDoneFooter(lastPart);
  return buildFeishuCard(text, cardTitle);
}

function usage(): void {
  console.error(`feishu-card-dry-run — inspect Feishu card payload from luckee CLI stdout

  npx tsx scripts/feishu-card-dry-run.ts -- <binary> [args...]
  npx tsx scripts/feishu-card-dry-run.ts --stdin
  npx tsx scripts/feishu-card-dry-run.ts ./saved-stdout.log

Env: LUCKEE_TITLE=query preview text for card header
`);
}

async function readStdin(): Promise<string> {
  return text(inputStdin);
}

async function runLuckee(argvSlice: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const [bin, ...args] = argvSlice;
  if (!bin) throw new Error("Missing binary after --");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, PYTHONUNBUFFERED: env.PYTHONUNBUFFERED ?? "1" },
    });
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  let rawOut = "";
  let meta: Record<string, unknown> = {};

  if (args.length === 0) {
    usage();
    exit(1);
  }

  if (args[0] === "--stdin") {
    rawOut = await readStdin();
    meta = { source: "stdin" };
  } else if (args[0] === "--") {
    const r = await runLuckee(args.slice(1));
    rawOut = r.stdout;
    meta = { source: "spawn", exitCode: r.code, stderrChars: r.stderr.length };
    if (r.stderr.trim()) {
      meta.stderrPreview = r.stderr.slice(0, 2000);
    }
  } else {
    const path = args[0];
    try {
      statSync(path);
      rawOut = readFileSync(path, "utf8");
      meta = { source: "file", path };
    } catch {
      usage();
      console.error(`Not a file: ${path}`);
      exit(1);
    }
  }

  const title = env.LUCKEE_TITLE || "dry-run";
  const stripped = stripLuckeeGeneratedFileLines(rawOut.trim() || "(empty)");
  const normalized = normalizeWrappedUrls(stripped);
  const mirror = buildFeishuCardMarkdownElementsWithMirror(withDoneFooter(normalized)).plainTextMirror;
  const card = pipelineFinalCardPayload(rawOut, title);

  const out = {
    meta: {
      ...meta,
      rawChars: rawOut.length,
      strippedChars: stripped.length,
      normalizedChars: normalized.length,
    },
    /** What users roughly see if markdown were flattened (plugin mirror). */
    plainTextMirror: mirror,
    /** Payload sent as im/v1/messages PATCH content (msg_type=interactive) after JSON.stringify(card). */
    feishuInteractiveCard: card,
    /** Markdown element bodies only (easy to grep). */
    markdownBodies: (card.body as { elements: { tag: string; content?: string }[] }).elements
      .filter((e) => e.tag === "markdown")
      .map((e) => e.content ?? ""),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
