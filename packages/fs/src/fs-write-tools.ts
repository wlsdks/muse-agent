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
import { applyEdits, type FsEditSpec } from "./fs-edit-engine.js";
import { isPathSafetyError, resolvePolicy, resolveSafePath, type PathSafetyOptions, type ResolvedPolicy } from "./fs-path-safety.js";

export { applyEdit, applyEdits, type EditOutcome, type FsEditSpec } from "./fs-edit-engine.js";

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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
