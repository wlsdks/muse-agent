/**
 * Read-tier `@muse/fs` tools — `file_read`, `file_list`, `file_grep`.
 * All paths pass through the path sandbox (`fs-path-safety`) before any IO,
 * so a denied/escaping path fails closed. Results carry a `source` field so
 * a read becomes a citeable grounding source (the core Muse edge).
 *
 * Naming disambiguates the classic confusable triple (tool-calling.md #2):
 * `file_read` (one file's bytes) vs `file_list` (find files by NAME/path
 * pattern) vs `file_grep` (find by CONTENT). Three distinct verbs.
 */

import { glob, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { createIgnoreFilter, type IgnoreFilter } from "./fs-gitignore.js";
import {
  defaultFileReadRoots,
  extractDocxTextWithMammoth,
  extractPdfTextWithPdfjs,
  imageMimeType,
  rankFileCandidates,
  resolveFileKind,
  walkCandidates,
  type FileCandidate
} from "./fs-document.js";
import { isPathSafetyError, resolvePolicy, resolveSafePath, type PathSafetyOptions, type ResolvedPolicy } from "./fs-path-safety.js";

/** Local vision callback for IMAGE files — bound by the CLI to the assembly's multimodal model. */
export type DescribeImage = (input: {
  readonly imageBase64: string;
  readonly mimeType: string;
}) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;

const DEFAULT_MAX_TEXT_CHARS = 200 * 1024;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The chars a SINGLE file_read may return for a model with `contextTokens` of
 * context window. The 200K `DEFAULT_MAX_TEXT_CHARS` (~50K tokens) exceeds even a
 * 32K-token window WHOLE — so on a small-context local model one max read would
 * overflow the window and the runtime silently drops the system prompt /
 * conversation. Cap a read to HALF the window (so it can never dominate the
 * context), at ~4 chars/token, and let the model page the rest via `nextOffset`.
 * Floored so a tiny misconfigured window still returns something useful.
 */
export function fileReadCharBudget(contextTokens: number): number {
  return Math.max(4 * 1024, Math.floor(contextTokens / 2) * 4);
}
const RECENT_LIST = 10;
const MAX_LIST_RESULTS = 1000;
const GREP_MAX_FILES = 2000;
const GREP_MAX_MATCHES = 200;
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const GREP_MAX_PATTERN_LENGTH = 1000;
const GREP_MAX_LINE_LENGTH = 50_000;

const EXCLUDED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage"
]);

export interface FsReadToolsOptions extends PathSafetyOptions {
  /** Vision callback for reading IMAGE files. Absent ⇒ images are refused. */
  readonly describeImage?: DescribeImage;
  /** Folders the NAME-fragment read mode searches. Default: Downloads/Desktop/Documents. */
  readonly docRoots?: readonly string[];
  /** PDF text extractor; defaults to the lazy pdfjs-dist implementation. */
  readonly extractPdfText?: (data: Buffer) => Promise<string>;
  /** DOCX text extractor; defaults to the lazy mammoth implementation. */
  readonly extractDocxText?: (data: Buffer) => Promise<string>;
  /** Cap on returned characters for a text/PDF/DOCX read. Default 200,000. */
  readonly maxTextChars?: number;
  /**
   * Cap on the TOTAL characters of file_grep content matches (sum of match
   * texts) — like {@link maxTextChars} for grep, so a broad grep can't dominate
   * a small model's context. Default 200,000 (effectively the GREP_MAX_MATCHES
   * cap); the agent passes {@link fileReadCharBudget}.
   */
  readonly maxGrepOutputChars?: number;
  /** Files larger than this are refused. Default 25MB. */
  readonly maxFileBytes?: number;
  /**
   * Called with the resolved canonical path on every SUCCESSFUL read. The CLI
   * wires it to a per-run set so the write tools' read-before-edit gate
   * (`wasPathRead`) can require a prior read before mutating that file.
   */
  readonly onPathRead?: (canonicalPath: string) => void;
  /**
   * Called ONLY on a FULL file read (file_read), never on a partial file_grep
   * match. The CLI wires it to a separate set so the stricter read-before-
   * OVERWRITE gate (`wasPathFullyRead`) can require that file_write's whole-file
   * replace was preceded by a full read, not just a grep of a few lines.
   */
  readonly onFullRead?: (canonicalPath: string) => void;
}

function looksLikePath(input: string): boolean {
  return input.startsWith("/") || input.startsWith("~") || input.startsWith(".") || input.includes("/") || input.includes("\\");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function refusalResult(error: unknown, path: string): JsonObject {
  if (isPathSafetyError(error)) {
    return { error: error.message, path, refused: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: message, path };
}

/** A `glob` exclude predicate that prunes heavyweight/system dirs. */
function isExcludedPath(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
}

function isProbablyBinary(content: string): boolean {
  return content.includes("\u0000");
}

export function createFileReadTool(options: FsReadToolsOptions = {}, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  const docRoots = (options.docRoots ?? defaultFileReadRoots()).slice();
  const extractPdf = options.extractPdfText ?? extractPdfTextWithPdfjs;
  const extractDocx = options.extractDocxText ?? extractDocxTextWithMammoth;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  /** Resolve the user's reference to a concrete, sandbox-approved file path. */
  const resolveTarget = async (
    input: string,
    resolved: ResolvedPolicy
  ): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly result: JsonObject }> => {
    if (looksLikePath(input)) {
      const safe = await resolveSafePath(input, options, resolved);
      return { ok: true, path: safe };
    }
    const candidates = await walkCandidates(docRoots);
    const ranked = rankFileCandidates(candidates, input);
    const top = ranked[0];
    if (!top) {
      const recent = [...candidates]
        .sort((a, b) => b.modifiedMs - a.modifiedMs)
        .slice(0, RECENT_LIST)
        .map((candidate: FileCandidate) => candidate.name);
      return {
        ok: false,
        result: { read: false, reason: `no file matching "${input}" in your everyday folders`, recent: recent as unknown as JsonValue }
      };
    }
    const safe = await resolveSafePath(top.path, { ...options, baseDir: docRoots[0] }, resolved);
    return { ok: true, path: safe };
  };

  return {
    definition: {
      description:
        "Read ONE local file and return its text — plain text/code, plus PDF, Word (.docx), and images " +
        "(read with the local vision model). Give a path ('~/notes/todo.md', '/Users/me/x.ts') OR, for your " +
        "everyday folders, a filename fragment ('invoice pdf', '계약서 워드', '영수증 사진') and Muse reads the " +
        "newest match. This is the right tool whenever the user names ONE file to open/read/summarize, even " +
        "if a folder is mentioned ('다운로드에 있는 invoice.pdf 읽어줘' → file_read). Use offset/limit to page " +
        "through a long text file — a truncated result returns `nextOffset`; pass it back as `offset` to read " +
        "the next page. Do NOT use to list many files by pattern (use file_list) or to search " +
        "inside files (use file_grep). Protected locations (keys, credentials) are refused.",
      domain: "files",
      groundedArgs: ["path"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "Optional max lines to read (text only), e.g. 100.", minimum: 1, type: "integer" },
          numbered: { description: "Prefix each line with its line number (text only, default false).", type: "boolean" },
          offset: { description: "Optional 1-based start line (text only), e.g. 200.", minimum: 1, type: "integer" },
          path: {
            description: "Path ('~/notes/todo.md', '/Users/me/x.ts') or a filename fragment to find ('invoice pdf', '영수증 사진').",
            type: "string"
          }
        },
        required: ["path"],
        type: "object"
      },
      keywords: ["file", "read", "open", "contents", "pdf", "문서", "document", "파일", "읽어", "열어", "내용", "요약", "summarize", "code", "source", "bug", "fix"],
      name: "file_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = asString(args["path"]);
      if (input.length === 0) {
        return { read: false, reason: "file_read needs `path` — a file path or a filename fragment to read" };
      }
      const resolved = await policy;
      let safe: string;
      try {
        const target = await resolveTarget(input, resolved);
        if (!target.ok) {
          return target.result;
        }
        safe = target.path;
      } catch (error) {
        return { ...refusalResult(error, input), read: false };
      }

      try {
        const info = await stat(safe);
        if (info.isDirectory()) {
          return { path: safe, read: false, reason: `'${input}' is a directory — use file_list to enumerate it.` };
        }
        if (info.size > maxFileBytes) {
          return {
            path: safe,
            read: false,
            reason: `'${basename(safe)}' is too large (${Math.round(info.size / 1024 / 1024).toString()}MB > ${Math.round(maxFileBytes / 1024 / 1024).toString()}MB)`
          };
        }
        const data = await readFile(safe);
        const kind = resolveFileKind(basename(safe), data);

        if (kind === "image") {
          if (!options.describeImage) {
            return { path: safe, read: false, reason: `'${basename(safe)}' is an image — image reading needs the local vision model, not available in this run` };
          }
          const described = await options.describeImage({ imageBase64: data.toString("base64"), mimeType: imageMimeType(basename(safe), data) });
          if (!described.ok || !described.text) {
            return { path: safe, read: false, reason: described.error ?? "the vision model could not read the image" };
          }
          options.onPathRead?.(safe);
          options.onFullRead?.(safe);
          return { kind: "image", path: safe, read: true, source: safe, text: described.text, truncated: false };
        }
        if (kind === "unsupported") {
          return { path: safe, read: false, reason: `'${basename(safe)}' is not a readable document (PDF, Word, text, or image files only)` };
        }

        if (kind === "pdf" || kind === "docx") {
          const extracted = kind === "pdf" ? await extractPdf(data) : await extractDocx(data);
          const truncated = extracted.length > maxTextChars;
          options.onPathRead?.(safe);
          if (!truncated) options.onFullRead?.(safe);
          return { kind, path: safe, read: true, source: safe, text: truncated ? extracted.slice(0, maxTextChars) : extracted, truncated };
        }

        const rawText = data.toString("utf8");
        // A text-EXTENSION file can still be binary (a null byte ⇒ not text). The
        // model gets corrupted, edit-poisoning output if we hand it back as text,
        // so refuse with a clear signal — the same binary skip file_grep applies.
        if (isProbablyBinary(rawText)) {
          return { path: safe, read: false, reason: `'${basename(safe)}' looks like a binary file (contains a NUL byte), not text — file_read reads text, PDF, Word, and image files.` };
        }
        const lines = rawText.split("\n");
        const totalLines = lines.length;
        const offset = asPositiveInt(args["offset"]);
        const limit = asPositiveInt(args["limit"]);
        const start = offset ? offset - 1 : 0;
        const sliced = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit);
        // Default text is RAW (no line-number prefixes) so the model can copy a
        // snippet verbatim as file_edit's old_string. `numbered: true` opts into a
        // cat -n style view for when the user wants to reference line numbers.
        const numbered = args["numbered"] === true;
        let text = numbered
          ? sliced.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join("\n")
          : sliced.join("\n");
        let truncated = start + sliced.length < totalLines;
        // The 1-based line to resume at, so the model pages a long file
        // deterministically (`file_read offset:nextOffset`) instead of guessing.
        // Only for a clean LINE boundary — a char-cap cut falls mid-line, so its
        // line offset would be imprecise and is omitted.
        let nextOffset = truncated ? start + sliced.length + 1 : undefined;
        if (text.length > maxTextChars) {
          const capped = text.slice(0, maxTextChars);
          truncated = true;
          // A char-cap cuts mid-line. Rather than drop paging entirely, TRIM the
          // trailing partial line so the page ends on a clean boundary, and page
          // from the first not-fully-shown line — deterministic, no partial line.
          // `completeLines` is the count of NEWLINE-terminated lines in the cut
          // (conservative: it treats the boundary line as not-yet-complete, so a
          // re-read overlaps by at most one line — never skips one). A single line
          // longer than the cap has no newline, so it can't be paged BY LINE.
          const completeLines = (capped.match(/\n/gu) ?? []).length;
          if (completeLines > 0) {
            text = capped.slice(0, capped.lastIndexOf("\n"));
            nextOffset = start + completeLines + 1;
          } else {
            text = capped;
            nextOffset = undefined;
          }
        }
        options.onPathRead?.(safe);
        // FULL read = started at the top (`start === 0`, i.e. no offset / offset 1)
        // AND nothing after the slice (`!truncated`). An OFFSET-skipped read
        // (offset:96 → truncated false but lines 1-95 unseen) is NOT full, so it
        // must not ground a whole-file overwrite.
        if (start === 0 && !truncated) options.onFullRead?.(safe);
        return { kind: "text", numbered, path: safe, read: true, source: safe, text, totalLines, truncated, ...(nextOffset !== undefined ? { nextOffset } : {}) };
      } catch (error) {
        // A raw "ENOENT … stat '/abs/path'" dead-ends the small model. Hand it a
        // recovery route instead: name the file + the tool that finds it.
        if (isNotFoundError(error)) {
          return { path: input, read: false, reason: `no file at '${input}' — check the path, or use file_list (e.g. pattern "**/${basename(input)}") to locate it by name.` };
        }
        return { ...refusalResult(error, input), read: false };
      }
    }
  };
}

export function createFileListTool(options: FsReadToolsOptions = {}, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  const baseDir = options.baseDir ?? process.cwd();
  return {
    definition: {
      description:
        "List MULTIPLE files matching a name/glob pattern — use ONLY when you don't know the exact file and " +
        "want a set of matches (e.g. 'all my markdown notes' -> '**/*.md', 'typescript files in src' -> " +
        "'src/**/*.ts'). Do NOT use when the user names ONE specific file to open/read/summarize, even if a " +
        "folder is mentioned ('read invoice.pdf in Downloads' is file_read, not file_list). Do NOT use to " +
        "search file contents (use file_grep).",
      domain: "files",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cwd: { description: "Optional base directory to search under, e.g. '~/notes'.", type: "string" },
          includeIgnored: { description: "Include git-ignored files (default false — .gitignore is honored).", type: "boolean" },
          limit: { description: "Max paths to return, e.g. 100.", maximum: MAX_LIST_RESULTS, minimum: 1, type: "integer" },
          pattern: { description: "Glob pattern, e.g. '**/*.md' or 'src/**/*.ts'.", type: "string" }
        },
        required: ["pattern"],
        type: "object"
      },
      keywords: ["list", "glob", "files", "목록", "어떤 파일", "패턴"],
      name: "file_list",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const pattern = asString(args["pattern"]);
      if (pattern.length === 0) {
        return { error: "pattern is required" };
      }
      const cwdArg = asString(args["cwd"]) || homedir();
      const limit = Math.min(asPositiveInt(args["limit"]) ?? MAX_LIST_RESULTS, MAX_LIST_RESULTS);
      let cwd: string;
      try {
        cwd = await resolveSafePath(cwdArg, options, await policy);
      } catch (error) {
        return refusalResult(error, cwdArg);
      }
      const resolved = await policy;
      const ignoreFilter = args["includeIgnored"] === true ? undefined : await createIgnoreFilter(cwd);
      const matches: string[] = [];
      try {
        for await (const entry of glob(pattern, { cwd, exclude: isExcludedPath })) {
          const absolute = join(cwd, entry);
          if (ignoreFilter?.ignores(absolute)) {
            continue;
          }
          try {
            const safe = await resolveSafePath(absolute, { ...options, baseDir }, resolved);
            matches.push(safe);
          } catch {
            continue;
          }
          if (matches.length >= limit) {
            break;
          }
        }
      } catch (error) {
        return refusalResult(error, pattern);
      }
      // `glob` iteration order is implementation/filesystem-defined (unspecified
      // by Node), so the same cwd could list files in a different order across
      // machines / pass^k repeats — input flake for the local model. Sort to a
      // deterministic, scannable order. (For the rare >limit case the SET is
      // still the glob-bounded first `limit`, a pre-existing truncation; only the
      // returned ORDER is made deterministic here.)
      matches.sort();
      return { count: matches.length, cwd, pattern, paths: matches, truncated: matches.length >= limit };
    }
  };
}

/**
 * Compile the model's `pattern` into a RegExp that NEVER throws. A small model
 * routinely emits an INVALID regex — a literal `}`/`{` (fatal under the `u`
 * flag's "lone quantifier brackets") or a DOUBLE-ESCAPED backslash (`\\}` where
 * it meant `\}`) — and a hard "invalid regular expression" error dead-ends the
 * agent: it loops on broken patterns and never reaches file_edit (observed in
 * eval:multifile-fix). So degrade gracefully — strict unicode first (valid
 * patterns are unchanged), then non-unicode (Annex B tolerates a lone `{`/`}`,
 * which is exactly the observed fatal case), and finally a LITERAL substring
 * (every regex metachar escaped) so a structurally-broken pattern still
 * searches for the text the model typed instead of dead-ending it.
 */
export function compileGrepPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    // u-mode is strict: a lone `{`/`}` (an unescaped literal brace) is fatal.
  }
  try {
    return new RegExp(pattern, "");
  } catch {
    // Structurally invalid (unbalanced (), trailing \) — fall through to literal.
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "");
}

/**
 * A model-supplied grep pattern runs on Muse's OWN process — JS `RegExp` is a
 * backtracking engine with no timeout, so a catastrophic pattern hangs the agent
 * (ReDoS; an `(a+)+$` on a 40-char failing line never returns). Reject the
 * classic form: an unbounded quantifier (`+`/`*`/`{n,}`) applied to a group whose
 * body ALSO contains an unbounded quantifier — `(a+)+`, `(.*)*`, `(\d+){2,}`.
 * Conservative flat-group heuristic (the form a small model could emit);
 * documented limit: alternation-overlap forms like `(a|aa)+` are not detected.
 */
export function isCatastrophicGrepPattern(pattern: string): boolean {
  return /\([^()]*[+*][^()]*\)(?:[*+]|\{\d+,\})/u.test(pattern);
}

export function createFileGrepTool(options: FsReadToolsOptions = {}, policyPromise?: Promise<ResolvedPolicy>): MuseTool {
  const policy = policyPromise ?? resolvePolicy(options);
  const baseDir = options.baseDir ?? process.cwd();
  return {
    definition: {
      description:
        "Search the CONTENTS of files for a regular expression. Use to find which files contain a string/" +
        "pattern (e.g. 'where did I write about the dentist' -> 'dentist|치과'). mode 'files' returns matching " +
        "paths only; mode 'content' returns matching lines with line numbers. Do NOT use to find files by " +
        "name (use file_list) or to read one known file (use file_read).",
      domain: "files",
      inputSchema: {
        additionalProperties: false,
        properties: {
          glob: { description: "Optional filename filter, e.g. '*.md' or '**/*.ts'. Default: all files.", type: "string" },
          includeIgnored: { description: "Include git-ignored files (default false — .gitignore is honored).", type: "boolean" },
          mode: {
            description: "'files' = matching paths only; 'content' = matching lines with line numbers.",
            enum: ["files", "content"],
            type: "string"
          },
          path: { description: "Optional directory or file to scope the search, e.g. '~/notes'.", type: "string" },
          pattern: { description: "Regular expression to search for, e.g. 'dentist|치과'.", type: "string" }
        },
        required: ["pattern"],
        type: "object"
      },
      keywords: ["grep", "search", "contents", "contain", "find", "검색", "내용", "찾아", "code", "source", "bug", "fix", "test"],
      name: "file_grep",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const patternText = asString(args["pattern"]);
      if (patternText.length === 0) {
        return { error: "pattern is required" };
      }
      if (patternText.length > GREP_MAX_PATTERN_LENGTH) {
        return { error: `pattern exceeds ${GREP_MAX_PATTERN_LENGTH.toString()} characters` };
      }
      if (isCatastrophicGrepPattern(patternText)) {
        return { error: "pattern looks catastrophically slow (a repeated group inside a repeat, e.g. (a+)+) — simplify it to avoid hanging the search" };
      }
      const regex = compileGrepPattern(patternText);
      // No `path`: default to a configured allow-root so a narrowed sandbox
      // (a project workspace) is searched, not the home dir — which would fall
      // outside `roots` and dead-end the agent. Unset roots ⇒ home (recall default).
      const defaultScope = options.roots?.[0] ?? homedir();
      const scopeArg = asString(args["path"]) || defaultScope;
      const fileGlob = asString(args["glob"]) || "**/*";
      const mode = args["mode"] === "content" ? "content" : "files";
      const resolved = await policy;

      let scope: string;
      try {
        scope = await resolveSafePath(scopeArg, options, resolved);
      } catch (error) {
        return refusalResult(error, scopeArg);
      }

      let searchRoot = scope;
      try {
        const info = await stat(scope);
        if (!info.isDirectory()) {
          searchRoot = baseDir;
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          return { error: `no path '${scopeArg}' to search — check it, or use file_list to find the right directory first.` };
        }
        return refusalResult(error, scopeArg);
      }

      const ignoreFilter: IgnoreFilter | undefined = args["includeIgnored"] === true ? undefined : await createIgnoreFilter(searchRoot);
      const maxGrepOutputChars = options.maxGrepOutputChars ?? DEFAULT_MAX_TEXT_CHARS;
      const matchedFiles: string[] = [];
      const contentMatches: Array<{ readonly file: string; readonly line: number; readonly text: string }> = [];
      let contentChars = 0;
      let scanned = 0;
      let truncated = false;

      try {
        for await (const entry of glob(fileGlob, { cwd: searchRoot, exclude: isExcludedPath })) {
          if (scanned >= GREP_MAX_FILES) {
            truncated = true;
            break;
          }
          const absolute = join(searchRoot, entry);
          if (ignoreFilter?.ignores(absolute)) {
            continue;
          }
          let safe: string;
          try {
            safe = await resolveSafePath(absolute, { ...options, baseDir }, resolved);
          } catch {
            continue;
          }
          let info;
          try {
            info = await stat(safe);
          } catch {
            continue;
          }
          if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) {
            continue;
          }
          scanned += 1;
          let content: string;
          try {
            content = await readFile(safe, "utf8");
          } catch {
            continue;
          }
          if (isProbablyBinary(content)) {
            continue;
          }
          if (mode === "files") {
            if (regex.test(content)) {
              matchedFiles.push(safe);
              if (matchedFiles.length >= GREP_MAX_MATCHES) {
                truncated = true;
                break;
              }
            }
            continue;
          }
          const lines = content.split("\n");
          for (let index = 0; index < lines.length; index += 1) {
            const rawLine = lines[index] ?? "";
            // Cap the substring handed to the (user-supplied) regex so one
            // pathological long line can't drive catastrophic backtracking.
            const lineText = rawLine.length > GREP_MAX_LINE_LENGTH ? rawLine.slice(0, GREP_MAX_LINE_LENGTH) : rawLine;
            if (regex.test(lineText)) {
              const text = lineText.slice(0, 500);
              contentMatches.push({ file: safe, line: index + 1, text });
              contentChars += text.length;
              // Stop on EITHER the match-count cap OR the total-output-char cap —
              // the latter keeps a broad grep from overflowing a small context.
              if (contentMatches.length >= GREP_MAX_MATCHES || contentChars >= maxGrepOutputChars) {
                truncated = true;
                break;
              }
            }
          }
          if (truncated) {
            break;
          }
        }
      } catch (error) {
        return refusalResult(error, scopeArg);
      }

      // A capped result must tell the 12B HOW to see the rest, or it pages
      // blindly / concludes off a partial match set. Only on truncation, and
      // only when the search wasn't already narrowed by a glob.
      const narrowingHint = truncated
        ? `result capped — narrow the search to see the rest: pass a more specific \`pattern\`${fileGlob === "**/*" ? ' or a `glob` (e.g. "src/**/*.ts")' : ""}.`
        : undefined;

      if (mode === "files") {
        return { count: matchedFiles.length, files: matchedFiles, mode, pattern: patternText, scanned, truncated, ...(narrowingHint ? { hint: narrowingHint } : {}) };
      }
      // A content-mode match surfaces the file's real lines to the model (it
      // copies file_edit's old_string straight from them), so it grounds a
      // later edit exactly as file_read does — and file_read marks a path read
      // even after an offset/limit PARTIAL view. Mark every file we returned
      // content from as read so the read-before-edit gate accepts a
      // grep→edit loop (the small model reaches for file_grep, not file_read,
      // to inspect; without this its correct, scoped edits are all refused).
      // "files" mode shows NO content, so it never marks read.
      for (const file of new Set(contentMatches.map((match) => match.file))) {
        options.onPathRead?.(file);
      }
      return { count: contentMatches.length, matches: contentMatches, mode, pattern: patternText, scanned, truncated, ...(narrowingHint ? { hint: narrowingHint } : {}) };
    }
  };
}

export function createFsReadTools(options: FsReadToolsOptions = {}): readonly MuseTool[] {
  const policy = resolvePolicy(options);
  return [
    createFileReadTool(options, policy),
    createFileListTool(options, policy),
    createFileGrepTool(options, policy)
  ];
}
