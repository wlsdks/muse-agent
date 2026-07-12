import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises";
import { resolve as nodePathResolve } from "node:path";

import type { ProactiveModelProviderLike } from "@muse/proactivity";

import { parseJudgeStringArray } from "./judge-output.js";
import { walkMarkdownFrom } from "./loopback-notes-helpers.js";

/**
 * `mode: "llm-judge"` search path for the `muse.notes` loopback MCP server.
 * Split out of `loopback-notes.ts` (which had grown past 700 LOC) so the
 * LLM-judge call plumbing lives apart from the tool-definition file.
 */

/**
 * System prompt for the `mode: "llm-judge"` notes
 * search. Explicit selection criteria + JSON-only output shape so
 * smaller (2–8B) local models still produce usable arrays. The
 * caller adds a defense-in-depth filter to drop hallucinated
 * paths after parsing (so any prompt drift is contained).
 */
const NOTES_JUDGE_SYSTEM_PROMPT =
  `You are a notes-path selector for a personal-JARVIS assistant.

INPUT
  Query: a natural-language question from the user.
  Notes:  a list of "[<path>] <preview>" pairs from the user's markdown.

TASK
  Return the paths most relevant to the query, in descending order of
  relevance. Use the preview to judge topical match — direct keyword
  overlap, paraphrase / synonym overlap, or clearly-related project /
  person / date context all count. Prefer recall over precision when
  the query is ambiguous; the caller caps the count downstream.

RULES
  1. Output STRICT JSON: a single array of path strings, no prose,
     no markdown fences, no leading or trailing text. Example:
     ["daily/2026-05-12.md","projects/q3-budget.md"]
  2. Each path MUST appear verbatim in the input (same casing, same
     extension, same separators). Do NOT invent new files, do NOT
     rewrite paths, do NOT prefix or suffix anything.
  3. Return [] when nothing meaningfully matches. Never fabricate
     a "best guess" path just to look helpful.
  4. Do not include the preview text in the output; only paths.`;

export interface NotesLlmJudgeArgs {
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly maxFileBytes: number;
  readonly judgePreviewChars: number;
  readonly judgeMaxCandidates: number;
  readonly modelProvider: ProactiveModelProviderLike;
  readonly model: string;
}

export interface NotesLlmJudgeResult {
  readonly paths: readonly string[];
  /**
   * Count of paths the model returned that did not
   * appear in the candidate set (i.e. fabricated). Surfaced
   * upstream as a search-result diagnostic so callers can detect
   * prompt drift without leaking the hallucinated strings.
   */
  readonly hallucinatedDropped: number;
}

export async function runNotesLlmJudge(args: NotesLlmJudgeArgs): Promise<NotesLlmJudgeResult> {
  const files: string[] = [];
  await walkMarkdownFrom(args.root, args.root, (rel) => { files.push(rel); }, new Set());
  if (files.length === 0) return { paths: [], hallucinatedDropped: 0 };

  // Build (path, preview) pairs. Preview = first non-blank chunk of the
  // note, capped to `judgePreviewChars`. Skips files over maxFileBytes
  // entirely (those would blow the prompt). Capped at judgeMaxCandidates.
  type Pair = { readonly path: string; readonly preview: string };
  const pairs: Pair[] = [];
  for (const rel of files) {
    if (pairs.length >= args.judgeMaxCandidates) break;
    const abs = nodePathResolve(args.root, rel);
    let stat: Awaited<ReturnType<typeof nodeStat>>;
    try {
      stat = await nodeStat(abs);
    } catch {
      continue;
    }
    if (stat.size > args.maxFileBytes) continue;
    let body: string;
    try {
      body = await nodeReadFile(abs, "utf8");
    } catch {
      continue;
    }
    const preview = previewOf(body, args.judgePreviewChars);
    pairs.push({ path: rel, preview });
  }
  if (pairs.length === 0) return { paths: [], hallucinatedDropped: 0 };

  const lines = pairs.map((p) => `[${p.path}] ${p.preview}`);
  const userMessage = `Query: ${args.query}\n\nNotes:\n${lines.join("\n")}\n\nReturn at most ${args.limit.toString()} paths.`;

  const response = await args.modelProvider.generate({
    maxOutputTokens: 320,
    messages: [
      { content: NOTES_JUDGE_SYSTEM_PROMPT, role: "system" },
      { content: userMessage, role: "user" }
    ],
    model: args.model,
    temperature: 0
  });
  const parsed = parseJudgeStringArray((response.output ?? "").trim());

  // Resolve in model order, drop hallucinated paths, cap at limit.
  // The defense-in-depth filter is non-negotiable: the prompt tells
  // the model not to invent paths but smaller models still do, and
  // returning a fabricated string upstream would break the caller's
  // muse.notes.read of the result.
  const known = new Set(pairs.map((p) => p.path));
  const seen = new Set<string>();
  const out: string[] = [];
  let hallucinatedDropped = 0;
  for (const path of parsed) {
    if (seen.has(path)) continue;
    if (!known.has(path)) {
      hallucinatedDropped += 1;
      continue;
    }
    seen.add(path);
    out.push(path);
    if (out.length >= args.limit) break;
  }
  return { paths: out, hallucinatedDropped };
}

function previewOf(body: string, maxChars: number): string {
  const collapsed = body.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}
