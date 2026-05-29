/**
 * `muse ingest` — eat the pain corpus. Muse's wedge (cited recall over your
 * own files) only serves the already-disciplined user until it can ingest the
 * scattered data the answer actually lives in. This converts an exported AI
 * chat history (ChatGPT / Claude `conversations.json`) into markdown notes in
 * the notes dir, so the EXISTING `muse notes reindex` + cited-recall pipeline
 * picks them up unchanged — "what did I work out with the AI about X" becomes a
 * source-cited answer from your own machine.
 *
 * The parsers are pure + tolerant (missing fields / non-text parts are skipped,
 * never thrown) so a real export with surprises still yields what it can.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export type ChatExportKind = "chatgpt" | "claude";

export interface IngestedConversation {
  readonly title: string;
  readonly createdIso?: string;
  readonly slug: string;
  readonly markdown: string;
}

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function slugifyTitle(title: string, fallback: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
  return slug.length > 0 ? slug : fallback;
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

/** Detect which export shape `parsed` is (an array of conversations), else undefined. */
export function detectChatExport(parsed: unknown): ChatExportKind | undefined {
  const items = asArray(parsed);
  if (items.length === 0) return undefined;
  const sample = items.find(isRecord);
  if (!sample) return undefined;
  if ("mapping" in sample && isRecord(sample.mapping)) return "chatgpt";
  if ("chat_messages" in sample && Array.isArray(sample.chat_messages)) return "claude";
  return undefined;
}

function chatGptText(message: Record<string, unknown>): string {
  const content = isRecord(message.content) ? message.content : undefined;
  if (!content) return "";
  // Normal text turns carry `parts: [string, ...]`; skip non-string parts
  // (images / tool payloads) rather than dumping `[object Object]`.
  const parts = asArray(content.parts).filter((p): p is string => typeof p === "string");
  if (parts.length > 0) return parts.join("\n").trim();
  return str(content.text).trim();
}

function parseOneChatGpt(conv: Record<string, unknown>, index: number): IngestedConversation | undefined {
  const mapping = isRecord(conv.mapping) ? conv.mapping : {};
  const turns: { turn: Turn; order: number }[] = [];
  let order = 0;
  for (const node of Object.values(mapping)) {
    if (!isRecord(node) || !isRecord(node.message)) continue;
    const message = node.message;
    const role = isRecord(message.author) ? str(message.author.role) : "";
    if (role !== "user" && role !== "assistant") continue; // skip system/tool
    const text = chatGptText(message);
    if (text.length === 0) continue;
    const ct = typeof message.create_time === "number" ? message.create_time : order;
    turns.push({ order: ct, turn: { role, text } });
    order += 1;
  }
  if (turns.length === 0) return undefined;
  turns.sort((a, b) => a.order - b.order);
  const title = str(conv.title).trim() || `ChatGPT conversation ${(index + 1).toString()}`;
  return buildConversation(title, isoFromEpochSeconds(conv.create_time), turns.map((t) => t.turn), `chatgpt-${(index + 1).toString()}`);
}

function claudeText(message: Record<string, unknown>): string {
  const direct = str(message.text).trim();
  if (direct.length > 0) return direct;
  const blocks = asArray(message.content)
    .filter(isRecord)
    .map((b) => str(b.text))
    .filter((t) => t.trim().length > 0);
  return blocks.join("\n").trim();
}

function parseOneClaude(conv: Record<string, unknown>, index: number): IngestedConversation | undefined {
  const turns: Turn[] = [];
  for (const raw of asArray(conv.chat_messages)) {
    if (!isRecord(raw)) continue;
    const sender = str(raw.sender);
    const role = sender === "human" || sender === "user" ? "user" : sender === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const text = claudeText(raw);
    if (text.length === 0) continue;
    turns.push({ role, text });
  }
  if (turns.length === 0) return undefined;
  const title = (str(conv.name) || str(conv.title)).trim() || `Claude conversation ${(index + 1).toString()}`;
  const created = str(conv.created_at).trim();
  return buildConversation(title, created.length > 0 ? created : undefined, turns, `claude-${(index + 1).toString()}`);
}

function buildConversation(title: string, createdIso: string | undefined, turns: readonly Turn[], fallbackSlug: string): IngestedConversation {
  const lines = [`# ${title}`, "", `_Imported chat${createdIso ? ` — ${createdIso}` : ""}_`, ""];
  for (const t of turns) {
    lines.push(`**${t.role === "user" ? "You" : "Assistant"}:** ${t.text}`, "");
  }
  return {
    ...(createdIso ? { createdIso } : {}),
    markdown: lines.join("\n").trim() + "\n",
    slug: slugifyTitle(title, fallbackSlug),
    title
  };
}

/** Parse an exported chat history (auto-detected) into per-conversation markdown notes. */
export function ingestChatExport(parsed: unknown): readonly IngestedConversation[] {
  const kind = detectChatExport(parsed);
  if (!kind) return [];
  const items = asArray(parsed);
  const out: IngestedConversation[] = [];
  items.forEach((conv, i) => {
    if (!isRecord(conv)) return;
    const one = kind === "chatgpt" ? parseOneChatGpt(conv, i) : parseOneClaude(conv, i);
    if (one) out.push(one);
  });
  // De-collide slugs so two same-titled chats don't overwrite each other.
  const seen = new Map<string, number>();
  return out.map((c) => {
    const n = (seen.get(c.slug) ?? 0) + 1;
    seen.set(c.slug, n);
    return n === 1 ? c : { ...c, slug: `${c.slug}-${n.toString()}` };
  });
}

export function registerIngestCommand(program: Command, io: ProgramIO): void {
  program
    .command("ingest <file>")
    .description("Ingest an exported AI chat history (ChatGPT/Claude conversations.json) into your notes corpus")
    .option("--out <dir>", "Destination notes subdir (default: <notes>/ingested)")
    .action(async (file: string, options: { readonly out?: string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (cause) {
        io.stderr(`Could not read/parse '${file}' as JSON: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const kind = detectChatExport(parsed);
      if (!kind) {
        io.stderr("Unrecognized export — expected a ChatGPT or Claude `conversations.json` (an array of conversations).\n");
        process.exitCode = 1;
        return;
      }
      const conversations = ingestChatExport(parsed);
      if (conversations.length === 0) {
        io.stdout(`Detected a ${kind} export, but found no conversations with text to ingest.\n`);
        return;
      }
      const dir = options.out?.trim() || join(resolveNotesDir(process.env), "ingested");
      await mkdir(dir, { recursive: true });
      for (const conv of conversations) {
        await writeFile(join(dir, `${conv.slug}.md`), conv.markdown, "utf8");
      }
      io.stdout(
        `Ingested ${conversations.length.toString()} ${kind} conversation(s) → ${dir}\n`
        + "Run `muse notes reindex` to make them searchable, then `muse ask --notes-only \"…\"`.\n"
      );
    });
}
