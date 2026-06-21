/**
 * Write-tier `@muse/fs` tools — `file_write`, `file_edit`,
 * `file_multi_edit`. All are `risk: "write"` and route through TWO
 * fail-close guards: the path sandbox (`fs-path-safety`) and an INJECTED
 * approval gate (no gate ⇒ no write). The gate is shown the exact draft
 * (path + summary + preview) and a deny / throw / timeout means the write
 * does NOT happen.
 *
 * No partial side-effects (agent-testing.md #3): every edit computes and
 * validates the FULL next file content first, asks the gate once, and only
 * then writes once. An invalid edit (old_string missing/ambiguous) or a
 * denied gate leaves the file byte-for-byte unchanged.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { checkEditIntegrity } from "./edit-integrity.js";
import { isPathSafetyError, resolvePolicy, resolveSafePath, type PathSafetyOptions, type ResolvedPolicy } from "./fs-path-safety.js";

const PREVIEW_CHARS = 400;

export interface FsWriteDraft {
  readonly action: "write" | "edit" | "multi_edit" | "delete" | "move";
  readonly path: string;
  /** Human-readable one-liner, e.g. "Overwrite todo.md" / "Apply 3 edits to config.ts". */
  readonly summary: string;
  /** A short preview of the new content (capped) for the confirm prompt. */
  readonly preview: string;
}

export interface FsWriteApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Presents the exact write draft to the user; returns approve/deny. Fail-close. */
export type FsWriteApprovalGate = (draft: FsWriteDraft) => Promise<FsWriteApprovalDecision> | FsWriteApprovalDecision;

export interface FsWriteToolsOptions extends PathSafetyOptions {
  /** REQUIRED — no gate means no write can ever happen (fail-close). */
  readonly approvalGate: FsWriteApprovalGate;
  /**
   * Read-before-edit grounding: when provided, file_edit / file_multi_edit
   * fail-close on a target whose resolved path this returns `false` for — Muse
   * only MUTATES a file it has actually read this session (the actuator analog
   * of "every claim cites a source"). Absent ⇒ no gate (fail-open, back-compat).
   * The CLI wires it to a per-run set that `file_read`'s `onPathRead` fills.
   */
  readonly wasPathRead?: (canonicalPath: string) => boolean;
  /**
   * Stricter read-before-OVERWRITE grounding: file_write replaces a file's WHOLE
   * contents, so a partial `file_grep` "read" (which also marks `wasPathRead`)
   * is not enough — the model could overwrite an existing file having seen only
   * the matched lines, silently dropping the rest. When provided, file_write's
   * overwrite of an existing file requires a FULL read (this returns true; the
   * CLI wires it to a set only `file_read` fills, NOT `file_grep`). Absent ⇒
   * file_write falls back to `wasPathRead` (back-compat).
   */
  readonly wasPathFullyRead?: (canonicalPath: string) => boolean;
  /**
   * Edit-integrity grounding: when true, file_edit / file_multi_edit fail-close
   * on a destructive edit (deletes a definition / unbalances delimiters) BEFORE
   * writing, so a small model's botched edit becomes a guided retry instead of a
   * corrupted file. Absent/false ⇒ no check (back-compat). The CLI turns it on
   * for the agent write path.
   */
  readonly checkEditIntegrity?: boolean;
}

export interface FsEditSpec {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

type EditOutcome = { readonly ok: true; readonly content: string; readonly fuzzy?: boolean } | { readonly ok: false; readonly reason: string };

const UNICODE_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-"],
  [/[\u2018\u2019\u201A\u201B]/gu, "'"],
  [/[\u201C\u201D\u201E\u201F]/gu, '"'],
  [/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/gu, " "]
]

function foldUnicode(line: string): string {
  let out = line.trim();
  for (const [pattern, replacement] of UNICODE_FOLDS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Progressive line-block relaxations, exact-first — the same ladder Codex's
 * `seek_sequence` uses so a recalled snippet still lands when it differs from
 * disk only by trailing whitespace, indentation, or typographic punctuation.
 * Level 0 (identity) is covered by the exact substring pass, so the fuzzy
 * fallback starts at trailing-whitespace.
 */
const LINE_RELAXATIONS: ReadonlyArray<(line: string) => string> = [
  (line) => line.replace(/\s+$/u, ""),
  (line) => line.trim(),
  foldUnicode
];

/**
 * When exact matching fails, find a UNIQUE contiguous block of file lines that
 * matches `oldString`'s lines under the most exact relaxation that yields any
 * match. Returns char offsets into `content`, or a reason. Uniqueness is
 * required at each level (we never guess a location), keeping Muse's
 * no-partial-side-effects posture stricter than Codex's first-match seek.
 */
function findFuzzyBlock(
  content: string,
  oldString: string
): { readonly ok: true; readonly start: number; readonly end: number } | { readonly ok: false; readonly reason: "none" | "ambiguous" } {
  const contentLines = content.split("\n");
  let pattern = oldString.split("\n");
  if (pattern.length > 1 && pattern[pattern.length - 1] === "") {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0 || pattern.length > contentLines.length) {
    return { ok: false, reason: "none" };
  }
  for (const relax of LINE_RELAXATIONS) {
    const relaxedPattern = pattern.map((line) => relax(line));
    const hits: number[] = [];
    for (let i = 0; i + pattern.length <= contentLines.length; i += 1) {
      let matched = true;
      for (let j = 0; j < pattern.length; j += 1) {
        if (relax(contentLines[i + j]!) !== relaxedPattern[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        hits.push(i);
      }
    }
    if (hits.length === 1) {
      const startLine = hits[0]!;
      let start = 0;
      for (let k = 0; k < startLine; k += 1) {
        start += contentLines[k]!.length + 1;
      }
      const matchedText = contentLines.slice(startLine, startLine + pattern.length).join("\n");
      return { end: start + matchedText.length, ok: true, start };
    }
    if (hits.length > 1) {
      return { ok: false, reason: "ambiguous" };
    }
  }
  return { ok: false, reason: "none" };
}

/** Exact (then unique line-block) match of `oldString`; null when neither hits. */
function matchAndReplace(content: string, oldString: string, newString: string, replaceAll: boolean): EditOutcome | null {
  const matches = countOccurrences(content, oldString);
  if (matches > 1 && !replaceAll) {
    return { ok: false, reason: `old_string matches ${matches.toString()} places — pass replace_all or use a longer, unique old_string` };
  }
  if (matches >= 1) {
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    return { content: next, ok: true };
  }
  // Exact match failed — fall back to a whitespace/punctuation-tolerant
  // line-block match (replace_all has no meaning for a single unique block).
  const fuzzy = findFuzzyBlock(content, oldString);
  if (!fuzzy.ok) {
    return fuzzy.reason === "ambiguous"
      ? { ok: false, reason: `old_string fuzzily matches multiple places — use a longer, unique old_string` }
      : null;
  }
  return { content: content.slice(0, fuzzy.start) + newString + content.slice(fuzzy.end), fuzzy: true, ok: true };
}

/**
 * Un-escape the JSON whitespace escapes a small model commonly DOUBLE-escapes —
 * it emits the two characters `\` `n` in its tool-call JSON instead of a real
 * newline, so the parsed old_string carries a literal `\n` that matches nothing.
 */
function unescapeWhitespace(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r|\\t/gu, (seq) => (seq === "\\t" ? "\t" : seq === "\\r" ? "\r" : "\n"));
}

/**
 * When an edit misses by genuine CONTENT (not whitespace — that's the fuzzy
 * pass), name the file's closest line so the model can copy it verbatim on its
 * next attempt instead of re-guessing. Deterministic: ranks lines by shared-word
 * overlap with old_string's first non-empty line and requires a real overlap
 * (≥ half the target words, ≥2) so an unrelated miss gets NO noisy hint.
 */
function nearestLineHint(content: string, oldString: string): string | undefined {
  const target = oldString.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!target) {
    return undefined;
  }
  const targetWords = new Set(target.split(/\s+/u).filter((word) => word.length > 0));
  if (targetWords.size === 0) {
    return undefined;
  }
  let best: { line: string; score: number } | undefined;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    let shared = 0;
    for (const word of line.split(/\s+/u)) {
      if (targetWords.has(word)) {
        shared += 1;
      }
    }
    if (shared > 0 && (!best || shared > best.score)) {
      best = { line, score: shared };
    }
  }
  if (best && best.score >= Math.max(2, Math.ceil(targetWords.size / 2))) {
    return best.line.slice(0, 120);
  }
  return undefined;
}

/** Apply ONE edit to `content`, validating uniqueness. Pure — never touches disk. */
export function applyEdit(content: string, spec: FsEditSpec): EditOutcome {
  if (spec.old_string.length === 0) {
    return { ok: false, reason: "old_string must not be empty" };
  }
  if (spec.old_string === spec.new_string) {
    return { ok: false, reason: "old_string and new_string are identical — nothing to change" };
  }
  const replaceAll = spec.replace_all === true;
  const direct = matchAndReplace(content, spec.old_string, spec.new_string, replaceAll);
  if (direct) {
    return direct;
  }
  // Exact + line-block both missed. If old_string carries literal `\n`/`\t`
  // escapes (a double-escaping local model), un-escape old AND new together and
  // retry once — only adopted when the repaired form actually matches, so a
  // verbatim backslash-n in source (which the exact pass already caught) is never
  // rewritten and we never guess a location.
  const repairedOld = unescapeWhitespace(spec.old_string);
  if (repairedOld !== spec.old_string) {
    const repaired = matchAndReplace(content, repairedOld, unescapeWhitespace(spec.new_string), replaceAll);
    if (repaired?.ok) {
      return { ...repaired, fuzzy: true };
    }
  }
  const hint = nearestLineHint(content, spec.old_string);
  return {
    ok: false,
    reason: `old_string not found: ${JSON.stringify(spec.old_string.slice(0, 80))}${
      hint ? `. Closest line in the file is ${JSON.stringify(hint)} — read the file and copy the exact text` : ""
    }`
  };
}

/** Apply edits in order on the evolving content; the first failure aborts (atomic). */
export function applyEdits(content: string, edits: readonly FsEditSpec[]): EditOutcome {
  let current = content;
  for (let index = 0; index < edits.length; index += 1) {
    const outcome = applyEdit(current, edits[index]!);
    if (!outcome.ok) {
      return { ok: false, reason: `edit ${(index + 1).toString()}: ${outcome.reason}` };
    }
    current = outcome.content;
  }
  return { content: current, ok: true };
}

function refusal(error: unknown, path: string): JsonObject {
  if (isPathSafetyError(error)) {
    return { path, reason: error.message, refused: true, written: false };
  }
  // A symlink at the target (caught atomically by O_NOFOLLOW at write time) is a
  // refusal, not a generic IO error — it's the fail-close on a dangling-symlink /
  // TOCTOU escape that the path check alone can't see.
  if ((error as NodeJS.ErrnoException).code === "ELOOP") {
    return { path, reason: `'${path}' is a symlink — refused (a symlink target could escape the sandbox)`, refused: true, written: false };
  }
  // A raw "ENOENT … stat '/abs/path'" dead-ends the small model and leaks the
  // resolved host path. Hand it the recovery route: file_edit/multi_edit only
  // modify an EXISTING file, so a missing target means create-it or wrong-path.
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return { path, reason: `no file at '${path}' — to create it use file_write; to edit an existing file, check the path or use file_list to find it.`, written: false };
  }
  return { path, reason: error instanceof Error ? error.message : String(error), written: false };
}

/**
 * Write `content` to an already-sandbox-approved path WITHOUT following a
 * symlink at the leaf. `O_NOFOLLOW` makes the kernel reject (ELOOP) a final
 * component that is a symlink — atomically, at open time — which closes the
 * dangling-symlink and TOCTOU escapes that a path-string check before a plain
 * `writeFile` cannot (the leaf can be a symlink the realpath ancestor-walk never
 * resolved, or one swapped in during the approval-gate await window).
 */
async function writeFileNoFollow(safePath: string, content: string): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await open(safePath, flags, 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/** Read an existing file without following a symlink leaf (ELOOP on a symlink). */
async function readFileNoFollow(safePath: string): Promise<string> {
  const handle = await open(safePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export function createFileWriteTool(options: FsWriteToolsOptions, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  return {
    definition: {
      description:
        "Create a NEW file or fully OVERWRITE an existing one with the given content. Use only when the user " +
        "clearly asks to create / save / replace a whole file (e.g. 'save this as ~/notes/draft.md'). For a " +
        "small change to an existing file, prefer file_edit. The exact write is shown and fires ONLY on " +
        "confirmation; protected locations are refused.",
      domain: "files",
      groundedArgs: ["path"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          content: { description: "Full file contents to write.", type: "string" },
          path: { description: "Target file path, e.g. '~/notes/draft.md'.", type: "string" }
        },
        required: ["path", "content"],
        type: "object"
      },
      keywords: ["file", "write", "create", "save", "overwrite", "파일", "저장", "생성", "만들어"],
      name: "file_write",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const path = asString(args["path"]).trim();
      if (path.length === 0) {
        return { reason: "file_write needs `path`", written: false };
      }
      if (typeof args["content"] !== "string") {
        return { reason: "file_write needs `content` (a string)", written: false };
      }
      const content = args["content"];
      let safe: string;
      try {
        safe = await resolveSafePath(path, options, await policy);
      } catch (error) {
        return refusal(error, path);
      }
      try {
        const info = await stat(safe).catch(() => undefined);
        if (info?.isDirectory()) {
          return { path: safe, reason: `'${path}' is a directory`, written: false };
        }
        const exists = info !== undefined;
        // Read-before-OVERWRITE: replacing an EXISTING file's whole contents is a
        // mutation of content the model must have grounded in — fail-close unless
        // it read the file first. A whole-file overwrite needs a FULL read
        // (`wasPathFullyRead`); a partial `file_grep` match (which also satisfies
        // `wasPathRead`, for the grep->edit loop) is NOT enough, or the model
        // could drop every unmatched line. Falls back to `wasPathRead` when the
        // caller doesn't track full reads separately. Creating a NEW file needs
        // no prior read (nothing to ground / lose).
        const wasRead = options.wasPathFullyRead ?? options.wasPathRead;
        if (exists && wasRead && !wasRead(safe)) {
          return {
            path: safe,
            reason: "ungrounded overwrite — read the FULL file with file_read before overwriting an existing file (a partial grep is not enough; Muse only replaces a file it has actually read)",
            written: false
          };
        }
        const draft: FsWriteDraft = {
          action: "write",
          path: safe,
          preview: content.slice(0, PREVIEW_CHARS),
          summary: `${exists ? "Overwrite" : "Create"} ${safe} (${content.length.toString()} chars)`
        };
        let decision: FsWriteApprovalDecision;
        try {
          decision = await options.approvalGate(draft);
        } catch (cause) {
          return { path: safe, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}`, written: false };
        }
        if (!decision.approved) {
          return { path: safe, reason: decision.reason ?? "not confirmed", written: false };
        }
        await mkdir(dirname(safe), { recursive: true });
        await writeFileNoFollow(safe, content);
        return { bytes: Buffer.byteLength(content, "utf8"), created: !exists, path: safe, written: true };
      } catch (error) {
        return refusal(error, path);
      }
    }
  };
}

function editExecutor(
  options: FsWriteToolsOptions,
  policy: Promise<ResolvedPolicy>,
  action: "edit" | "multi_edit"
) {
  return async (path: string, edits: readonly FsEditSpec[]): Promise<JsonObject> => {
    if (path.length === 0) {
      return { reason: `${action === "edit" ? "file_edit" : "file_multi_edit"} needs \`path\``, written: false };
    }
    let safe: string;
    try {
      safe = await resolveSafePath(path, options, await policy);
    } catch (error) {
      return refusal(error, path);
    }
    if (options.wasPathRead && !options.wasPathRead(safe)) {
      return {
        path: safe,
        reason: "ungrounded edit — read the file with file_read before editing it (Muse only modifies a file it has actually read)",
        written: false
      };
    }
    let original: string;
    try {
      const info = await stat(safe);
      if (info.isDirectory()) {
        return { path: safe, reason: `'${path}' is a directory`, written: false };
      }
      original = await readFileNoFollow(safe);
    } catch (error) {
      return refusal(error, path);
    }
    const outcome = applyEdits(original, edits);
    if (!outcome.ok) {
      return { path: safe, reason: outcome.reason, written: false };
    }
    if (outcome.content === original) {
      return { path: safe, reason: "edits produced no change", written: false };
    }
    if (options.checkEditIntegrity) {
      const integrity = checkEditIntegrity(original, outcome.content);
      if (!integrity.ok) {
        return { path: safe, reason: integrity.reason ?? "edit failed an integrity check", written: false };
      }
    }
    const draft: FsWriteDraft = {
      action,
      path: safe,
      preview: outcome.content.slice(0, PREVIEW_CHARS),
      summary: `Apply ${edits.length.toString()} edit${edits.length === 1 ? "" : "s"} to ${safe}`
    };
    let decision: FsWriteApprovalDecision;
    try {
      decision = await options.approvalGate(draft);
    } catch (cause) {
      return { path: safe, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}`, written: false };
    }
    if (!decision.approved) {
      return { path: safe, reason: decision.reason ?? "not confirmed", written: false };
    }
    try {
      await writeFileNoFollow(safe, outcome.content);
    } catch (error) {
      return refusal(error, path);
    }
    return { edits: edits.length, path: safe, written: true };
  };
}

function parseEdit(value: unknown): FsEditSpec | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["old_string"] !== "string" || typeof record["new_string"] !== "string") {
    return undefined;
  }
  return {
    new_string: record["new_string"],
    old_string: record["old_string"],
    ...(typeof record["replace_all"] === "boolean" ? { replace_all: record["replace_all"] } : {})
  };
}

export function createFileEditTool(options: FsWriteToolsOptions, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  const run = editExecutor(options, policy, "edit");
  return {
    definition: {
      description:
        "Replace ONE exact piece of text inside an EXISTING file. old_string must match exactly and be " +
        "unique unless replace_all is set. The file must already exist (use file_write to create). For " +
        "several changes to the same file at once, use file_multi_edit. The change is shown and fires ONLY " +
        "on confirmation.",
      domain: "files",
      groundedArgs: ["path"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          new_string: { description: "Replacement text.", type: "string" },
          old_string: { description: "Exact text to find (unique unless replace_all), e.g. 'const PORT = 3000'.", type: "string" },
          path: { description: "File to edit, e.g. '~/notes/todo.md'.", type: "string" },
          replace_all: { description: "Replace every occurrence (default false).", type: "boolean" }
        },
        required: ["path", "old_string", "new_string"],
        type: "object"
      },
      keywords: ["file", "edit", "replace", "change", "modify", "파일", "수정", "바꿔", "고쳐", "code", "source", "bug", "fix"],
      name: "file_edit",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const spec = parseEdit(args);
      if (!spec) {
        return { reason: "file_edit needs `old_string` and `new_string` (strings)", written: false };
      }
      return run(asString(args["path"]).trim(), [spec]);
    }
  };
}

export function createFileMultiEditTool(options: FsWriteToolsOptions, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  const run = editExecutor(options, policy, "multi_edit");
  return {
    definition: {
      description:
        "Apply SEVERAL exact-text replacements to ONE existing file, in order. Use only when you have 2+ " +
        "edits to the same file; for a single change use file_edit. Each edit's old_string must match " +
        "exactly. All edits are validated first — if any fails, NOTHING is written. Shown and fires ONLY on " +
        "confirmation.",
      domain: "files",
      groundedArgs: ["path"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          edits: {
            description: "Edits applied in order.",
            items: {
              additionalProperties: false,
              properties: {
                new_string: { description: "Replacement text.", type: "string" },
                old_string: { description: "Exact text to find.", type: "string" },
                replace_all: { description: "Replace every occurrence (default false).", type: "boolean" }
              },
              required: ["old_string", "new_string"],
              type: "object"
            },
            minItems: 1,
            type: "array"
          },
          path: { description: "File to edit, e.g: '~/notes/todo.md'.", type: "string" }
        },
        required: ["path", "edits"],
        type: "object"
      },
      keywords: ["file", "edit", "edits", "replace", "multiple", "파일", "수정", "여러", "일괄", "code", "source", "bug", "fix"],
      name: "file_multi_edit",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const rawEdits = args["edits"];
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return { reason: "file_multi_edit needs a non-empty `edits` array", written: false };
      }
      const specs: FsEditSpec[] = [];
      for (const raw of rawEdits) {
        const spec = parseEdit(raw);
        if (!spec) {
          return { reason: "each edit needs `old_string` and `new_string` (strings)", written: false };
        }
        specs.push(spec);
      }
      return run(asString(args["path"]).trim(), specs);
    }
  };
}

export function createFileDeleteTool(options: FsWriteToolsOptions, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  return {
    definition: {
      description:
        "Delete ONE file. Use when the user clearly asks to delete / remove a specific file (e.g. 'delete " +
        "~/notes/old.md'). Refuses directories (only single files) and protected locations. The exact target " +
        "is shown and the delete fires ONLY on confirmation; this is not easily reversible.",
      domain: "files",
      groundedArgs: ["path"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          path: { description: "File to delete, e.g. '~/notes/old.md'.", type: "string" }
        },
        required: ["path"],
        type: "object"
      },
      keywords: ["file", "delete", "remove", "파일", "삭제", "지워"],
      name: "file_delete",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const path = asString(args["path"]).trim();
      if (path.length === 0) {
        return { deleted: false, reason: "file_delete needs `path`" };
      }
      let safe: string;
      try {
        safe = await resolveSafePath(path, options, await policy);
      } catch (error) {
        return { ...refusal(error, path), deleted: false };
      }
      try {
        // lstat (not stat) so a symlink is classified as a link, not its target:
        // deleting a real directory is refused; unlink removes a file or a symlink
        // (the link itself, never its target) — both safe.
        const info = await lstat(safe);
        if (info.isDirectory()) {
          return { deleted: false, path: safe, reason: `'${path}' is a directory — file_delete only removes single files` };
        }
        const draft: FsWriteDraft = { action: "delete", path: safe, preview: "", summary: `Delete ${safe}` };
        let decision: FsWriteApprovalDecision;
        try {
          decision = await options.approvalGate(draft);
        } catch (cause) {
          return { deleted: false, path: safe, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
        }
        if (!decision.approved) {
          return { deleted: false, path: safe, reason: decision.reason ?? "not confirmed" };
        }
        await unlink(safe);
        return { deleted: true, path: safe };
      } catch (error) {
        return { deleted: false, path: safe, reason: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export function createFileMoveTool(options: FsWriteToolsOptions, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  return {
    definition: {
      description:
        "Move or rename ONE file. Both the source and destination must be inside the sandbox and not " +
        "protected. Use when the user asks to rename or move a file (e.g. 'rename ~/notes/a.md to b.md', " +
        "'move report.md into ~/archive'). Refuses if the destination already exists. Shown and fires ONLY " +
        "on confirmation.",
      domain: "files",
      groundedArgs: ["from", "to"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          from: { description: "Existing source file path, e.g. '~/notes/a.md'.", type: "string" },
          to: { description: "Destination path, e.g. '~/notes/b.md' or '~/archive/a.md'.", type: "string" }
        },
        required: ["from", "to"],
        type: "object"
      },
      keywords: ["file", "move", "rename", "파일", "이동", "이름", "옮겨"],
      name: "file_move",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const fromArg = asString(args["from"]).trim();
      const toArg = asString(args["to"]).trim();
      if (fromArg.length === 0 || toArg.length === 0) {
        return { moved: false, reason: "file_move needs `from` and `to`" };
      }
      const resolved = await policy;
      let from: string;
      let to: string;
      try {
        from = await resolveSafePath(fromArg, options, resolved);
        to = await resolveSafePath(toArg, options, resolved);
      } catch (error) {
        return { ...refusal(error, fromArg), moved: false };
      }
      try {
        const src = await lstat(from).catch(() => undefined);
        if (!src) {
          return { from, moved: false, reason: `source '${fromArg}' does not exist` };
        }
        if (src.isDirectory()) {
          return { from, moved: false, reason: `'${fromArg}' is a directory — file_move only moves single files` };
        }
        const destExists = await lstat(to).then(() => true).catch(() => false);
        if (destExists) {
          return { moved: false, reason: `destination '${toArg}' already exists — refusing to overwrite`, to };
        }
        const draft: FsWriteDraft = { action: "move", path: to, preview: "", summary: `Move ${from} → ${to}` };
        let decision: FsWriteApprovalDecision;
        try {
          decision = await options.approvalGate(draft);
        } catch (cause) {
          return { moved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
        }
        if (!decision.approved) {
          return { moved: false, reason: decision.reason ?? "not confirmed" };
        }
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
        return { from, moved: true, to };
      } catch (error) {
        return { from, moved: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export function createFsWriteTools(options: FsWriteToolsOptions): readonly MuseTool[] {
  const policy = resolvePolicy(options);
  return [
    createFileWriteTool(options, policy),
    createFileEditTool(options, policy),
    createFileMultiEditTool(options, policy),
    createFileDeleteTool(options, policy),
    createFileMoveTool(options, policy)
  ];
}
