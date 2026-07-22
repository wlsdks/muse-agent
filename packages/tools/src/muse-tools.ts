import { isRecord, type JsonObject, type JsonValue } from "@muse/shared";
import { runRegexMatchesWithTimeout } from "./regex-timeout.js";
import type { MuseTool } from "./index.js";
import {
  createBase64Tool,
  createCsvParseTool,
  createHashTextTool,
  createMathEvalTool
} from "./muse-tools-data.js";
import {
  createCronForDatetimeTool,
  createNextWeekdayTool,
  createTimeAddTool,
  createTimeDiffTool,
  createTimeNowTool,
  createTimeRelativeTool
} from "./muse-tools-time.js";
import {
  createKvSummarizeTool,
  createMarkdownTableTool,
  createSlugifyTool,
  createTextStatsTool
} from "./muse-tools-text.js";
import { createLunarDateTool, createLunarToSolarTool } from "./muse-tools-lunar.js";
import { createKoreanNumberTool } from "./muse-tools-korean-number.js";
import { createEpochConvertTool } from "./muse-tools-epoch.js";
import { createNumberBaseTool } from "./muse-tools-number-base.js";
import { createLeapYearTool } from "./muse-tools-leap-year.js";
import { createKoreanAgeTool } from "./muse-tools-korean-age.js";
import { createUnitConvertTool } from "./muse-tools-units.js";

/**
 * Curated zero-IO Muse ambient utility tools that ship with every Muse runtime.
 *
 * Properties:
 * - Pure functions over their inputs (no network, no filesystem, no clock outside `time_*`).
 * - Deterministic given identical inputs (or identical `now()` for time tools).
 * - Safe risk: every tool is a read-only computation.
 * - No vendor coupling — these are the ambient capabilities every Muse agent should always
 *   have, independent of which model provider, MCP server, or external system is configured.
 *
 * Anything that requires IO belongs in a dedicated tool (e.g. Rust runner, MCP-bridged tool).
 */

export interface MuseToolFactoryOptions {
  /** Override the wall clock for `time_*` tools. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export function createMuseTools(options: MuseToolFactoryOptions = {}): readonly MuseTool[] {
  const now = options.now ?? (() => new Date());
  return [
    createTimeNowTool(now),
    createTimeDiffTool(),
    createTimeAddTool(),
    createTimeRelativeTool(now),
    createNextWeekdayTool(now),
    createTextStatsTool(),
    createMathEvalTool(),
    createUnitConvertTool(),
    createLunarDateTool(now),
    createLunarToSolarTool(now),
    createKoreanNumberTool(),
    createEpochConvertTool(),
    createNumberBaseTool(),
    createLeapYearTool(),
    createKoreanAgeTool(now),
    createJsonQueryTool(),
    createSlugifyTool(),
    createUrlPartsTool(),
    createRegexExtractTool(),
    createKvSummarizeTool(),
    createMarkdownTableTool(),
    createHashTextTool(),
    createCsvParseTool(),
    createBase64Tool(),
    createCronForDatetimeTool()
  ];
}

function createJsonQueryTool(): MuseTool {
  return {
    definition: {
      description:
        "Extracts a value at a dotted JSON path from a JSON document. Supports object keys and zero-indexed array segments (e.g. 'users.0.name'). Returns `null` when the path does not resolve.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          // A single "object" type, not the union the value actually accepts: a
          // type array is the only one in the repo and several provider schema
          // dialects (OpenAI strict, the Gemini sanitiser) reject it. Arrays
          // still work at runtime; the description says so.
          document: { description: "The JSON value to query — an object, or an array wrapped in one. e.g. { \"users\": [{ \"name\": \"Ada\" }] }.", type: "object" },
          path: { description: "Dotted path, e.g. 'users.0.name'.", type: "string" }
        },
        required: ["document", "path"],
        type: "object"
      },
      domain: "core",
      keywords: ["json", "query", "extract"],
      name: "json_query",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (path.length === 0) {
        return { error: "path is required" };
      }
      if (args["document"] === undefined) {
        return { error: "document is required — pass the JSON object itself, e.g. document: {\"users\":[{\"name\":\"Ada\"}]}" };
      }
      if (typeof args["document"] === "string") {
        return { error: "document must be a JSON object/array, not a JSON string — pass the parsed object" };
      }
      if (path.includes("[") || path.includes("]") || path.startsWith("$")) {
        return { error: "path must be dotted with bare numeric segments for array indices — use 'users.0.name', not 'users[0].name'" };
      }
      const document = args["document"] ?? null;
      const segments = path.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
      let cursor: JsonValue | null = document === null || document === undefined ? null : document;
      for (const segment of segments) {
        if (cursor === null || cursor === undefined) {
          return { found: false, path, value: null };
        }
        if (Array.isArray(cursor)) {
          const index = Number.parseInt(segment, 10);
          if (!Number.isFinite(index) || index < 0 || index >= cursor.length) {
            return { found: false, path, value: null };
          }
          cursor = cursor[index] ?? null;
          continue;
        }
        if (isRecord(cursor)) {
          const record = cursor;
          if (!Object.hasOwn(record, segment)) {
            return { found: false, path, value: null };
          }
          cursor = record[segment] ?? null;
          continue;
        }
        return { found: false, path, value: null };
      }
      return { found: cursor !== null && cursor !== undefined, path, value: cursor };
    }
  };
}

function createUrlPartsTool(): MuseTool {
  return {
    definition: {
      description:
        "Parses a URL into its components: `protocol` (without trailing colon), `host`, `port` (number when explicit, null otherwise), `path`, `query` (object of decoded key/values, last write wins), `hash` (without leading #), and `origin`. Invalid input returns `{ error: ... }`. " +
        "Useful when the agent needs to compose new URLs, classify links by host, or pull a single query parameter without piping through a string library.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          url: { description: "Absolute URL string.", type: "string" }
        },
        required: ["url"],
        type: "object"
      },
      domain: "core",
      keywords: ["url", "parse", "link", "host"],
      name: "url_parts",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const raw = typeof args["url"] === "string" ? args["url"].trim() : "";
      if (raw.length === 0) {
        return { error: "url is required" };
      }
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return { error: "url must be an absolute URL" };
      }
      const query: Record<string, string> = {};
      for (const [key, value] of parsed.searchParams.entries()) {
        query[key] = value;
      }
      const protocol = parsed.protocol.replace(/:$/u, "");
      const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : null;
      return {
        hash: parsed.hash.replace(/^#/u, ""),
        host: parsed.host,
        origin: parsed.origin,
        path: parsed.pathname,
        port,
        protocol,
        query
      } satisfies JsonObject;
    }
  };
}

const REGEX_EXTRACT_MAX_TEXT_LENGTH = 100_000;
const REGEX_EXTRACT_MAX_PATTERN_LENGTH = 500;
const REGEX_EXTRACT_MAX_MATCHES = 1_000;
// Wall-clock ceiling for a single match, enforced off-thread. Generous for a
// legit match over 100k chars; short enough that a catastrophic pattern cannot
// stall a turn.
const REGEX_EXTRACT_TIMEOUT_MS = 1_000;
const REGEX_EXTRACT_ALLOWED_FLAGS = /^[gimsuy]*$/u;
// A pattern like "/[a-z]+@[a-z.]+/g" compiles fine as regex SOURCE (the
// slashes and trailing letters become literal characters), so it silently
// matches nothing instead of erroring — catch the JS-literal shape before
// compiling and point the caller at the `flags` argument instead.
const REGEX_EXTRACT_LITERAL_FORM = /^\/.*\/[gimsuy]*$/u;

/** True when a body fragment contains an unescaped unbounded quantifier (* + {n,}). */
function fragmentHasUnboundedQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "*" || c === "+") return true;
    if (c === "{" && /^\{\d*,\}/u.test(body.slice(i))) return true;
  }
  return false;
}

/**
 * Detect the nested-quantifier shape that causes catastrophic backtracking —
 * a group that is itself unbounded-quantified AND whose body contains another
 * unbounded quantifier ((a+)+, (.*)*, ([a-z]+){2,}). Proper paren matching
 * (stack, escape-aware) so nesting and literal `\(` are handled. This is the
 * `safe-regex` star-height heuristic: it catches the common catastrophic class
 * (a 50-char input made regex_extract hang for ~90s), NOT every ReDoS — e.g.
 * overlapping alternation `(a|ab)+` is out of scope and still bounded only by
 * the input-length cap. Exported for direct unit coverage.
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const stack: number[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "(") { stack.push(i); continue; }
    if (c === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      const after = pattern.slice(i + 1);
      const groupQuantified = /^[*+]/u.test(after) || /^\{\d*,\}/u.test(after);
      if (groupQuantified && fragmentHasUnboundedQuantifier(pattern.slice(start + 1, i))) {
        return true;
      }
    }
  }
  return false;
}

/** Does `after` (the text right after a `)`) start with a quantifier that lets
 *  the group repeat 2+ times — `*`, `+`, `{n,}`, or `{n,m}` with m ≥ 2? The old
 *  guard missed the bounded `{2,50}` form, which backtracks just as badly. */
function groupCanRepeat(after: string): boolean {
  if (/^[*+]/u.test(after)) return true;
  const braced = /^\{(\d*),(\d*)\}/u.exec(after);
  if (!braced) return false;
  const max = braced[2];
  if (max === undefined || max.length === 0) return true; // {n,}
  return Number(max) >= 2;
}

/** Do two alternation branches share a possible FIRST character? `a|aa` → yes
 *  (both start 'a'), `cat|dog` → no. Overlapping branches under a repeated group
 *  are the `(a|aa)+` catastrophic shape the nested-quantifier guard cannot see. */
function alternationBranchesOverlap(body: string): boolean {
  // Split on top-level `|` only (ignore `|` inside nested groups / classes).
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "\\") { current += c + (body[i + 1] ?? ""); i += 1; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (!inClass && c === "(") depth += 1;
    else if (!inClass && c === ")") depth -= 1;
    if (c === "|" && depth === 0 && !inClass) { branches.push(current); current = ""; continue; }
    current += c;
  }
  branches.push(current);
  if (branches.length < 2) return false;
  const firsts = branches.map((b) => b.trim().charAt(0)).filter((ch) => ch.length > 0);
  return new Set(firsts).size < firsts.length;
}

/** A repeatable group whose body is an OVERLAPPING alternation — the `(a|aa)+`
 *  class the nested-unbounded-quantifier guard misses because the body has no
 *  quantifier of its own. Also catches a repeatable group whose body simply has
 *  a nested quantifier when the OUTER quantifier is bounded (`(a+){2,50}`). */
function hasRepeatedGroupRisk(pattern: string): boolean {
  const stack: number[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "(") { stack.push(i); continue; }
    if (c === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      if (!groupCanRepeat(pattern.slice(i + 1))) continue;
      const body = pattern.slice(start + 1, i).replace(/^\?[:=!]|^\?<[^>]*>/u, "");
      if (fragmentHasUnboundedQuantifier(body) || alternationBranchesOverlap(body)) {
        return true;
      }
    }
  }
  return false;
}

function createRegexExtractTool(): MuseTool {
  return {
    definition: {
      description:
        "Extracts substrings from `text` matching a JavaScript regular expression `pattern`. " +
        "Returns up to 1000 matches: when the pattern has no capturing group, each item is the full match; when the pattern has at least one group, each item is the first captured group. " +
        "Optional `flags` accepts only g/i/m/s/u/y (rejects others). Bounded inputs: text ≤ 100k characters, pattern ≤ 500 characters. " +
        "Useful for pulling emails, phone numbers, dates, hashtags, or other repeating structures from free-form text without piping through a string library.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          flags: {
            description: "Regex flags subset of g/i/m/s/u/y. Defaults to 'g'.",
            type: "string"
          },
          pattern: { description: "JavaScript regular expression source, e.g. '\\\\b\\\\d{4}-\\\\d{2}-\\\\d{2}\\\\b' to pull out ISO dates.", type: "string" },
          text: { description: "The text to scan, e.g. a pasted email body or note.", type: "string" }
        },
        required: ["pattern", "text"],
        type: "object"
      },
      domain: "core",
      keywords: ["regex", "extract", "match", "find"],
      name: "regex_extract",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const pattern = typeof args["pattern"] === "string" ? args["pattern"] : "";
      const flagsInput = typeof args["flags"] === "string" ? args["flags"] : "g";
      if (pattern.length === 0) {
        return { error: "pattern is required" };
      }
      if (typeof args["text"] !== "string") {
        return { error: "text is required and must be a string — pass the text to scan, e.g. text: 'mail me at a@b.com'" };
      }
      const text = args["text"];
      if (pattern.length > REGEX_EXTRACT_MAX_PATTERN_LENGTH) {
        return { error: `pattern must be ≤ ${REGEX_EXTRACT_MAX_PATTERN_LENGTH} characters` };
      }
      if (text.length > REGEX_EXTRACT_MAX_TEXT_LENGTH) {
        return { error: `text must be ≤ ${REGEX_EXTRACT_MAX_TEXT_LENGTH} characters` };
      }
      if (!REGEX_EXTRACT_ALLOWED_FLAGS.test(flagsInput)) {
        return { error: "flags must be a subset of g/i/m/s/u/y" };
      }
      if (REGEX_EXTRACT_LITERAL_FORM.test(pattern)) {
        return { error: "pattern must be the regex SOURCE without / delimiters — use '[a-z]+@[a-z.]+' and put flags in the 'flags' argument" };
      }
      // Fast-fail the obvious catastrophic shapes with a clear message before
      // paying worker-startup cost. This is an OPTIMISATION, not the guarantee:
      // static classification of ReDoS is undecidable, so the real backstop is
      // the timeout runner below, which kills any pattern — known shape or not —
      // that blows the deadline. (A bare `(a+)+`, and the two shapes this guard
      // used to miss — `(a|aa)+`, `(a+){2,50}` — both hang for tens of seconds.)
      if (hasNestedUnboundedQuantifier(pattern) || hasRepeatedGroupRisk(pattern)) {
        return { error: "pattern looks vulnerable to catastrophic backtracking (a repeatable group whose body is also ambiguous, e.g. (a+)+ or (a|aa)+) — simplify it" };
      }
      const flags = flagsInput.includes("g") ? flagsInput : `${flagsInput}g`;
      const run = await runRegexMatchesWithTimeout(pattern, flags, text, REGEX_EXTRACT_MAX_MATCHES, REGEX_EXTRACT_TIMEOUT_MS);
      if (run.timedOut) {
        return { error: `pattern took too long (> ${REGEX_EXTRACT_TIMEOUT_MS.toString()}ms) — it likely backtracks catastrophically on this text; simplify it` };
      }
      if (run.error !== undefined) {
        return { error: `invalid pattern: ${run.error}` };
      }
      return { matches: [...(run.matches ?? [])] } satisfies JsonObject;
    }
  };
}
