import type { JsonObject, JsonValue } from "@muse/shared";
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
          document: { description: "Source JSON value (object or array)." },
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
      const path = typeof args["path"] === "string" ? (args["path"] as string).trim() : "";
      const document = args["document"] ?? null;
      if (path.length === 0) {
        return { error: "path is required" };
      }
      const segments = path.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
      let cursor: JsonValue | null = document as JsonValue;
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
        if (typeof cursor === "object") {
          const record = cursor as Record<string, JsonValue | null>;
          if (!Object.prototype.hasOwnProperty.call(record, segment)) {
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
      const raw = typeof args["url"] === "string" ? (args["url"] as string).trim() : "";
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
const REGEX_EXTRACT_ALLOWED_FLAGS = /^[gimsuy]*$/u;

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
          pattern: { description: "JavaScript regular expression source.", type: "string" },
          text: { description: "Source text to scan.", type: "string" }
        },
        required: ["pattern", "text"],
        type: "object"
      },
      domain: "core",
      keywords: ["regex", "extract", "match", "find"],
      name: "regex_extract",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const pattern = typeof args["pattern"] === "string" ? (args["pattern"] as string) : "";
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      const flagsInput = typeof args["flags"] === "string" ? (args["flags"] as string) : "g";
      if (pattern.length === 0) {
        return { error: "pattern is required" };
      }
      if (pattern.length > REGEX_EXTRACT_MAX_PATTERN_LENGTH) {
        return { error: `pattern must be ≤ ${REGEX_EXTRACT_MAX_PATTERN_LENGTH} characters` };
      }
      if (text.length > REGEX_EXTRACT_MAX_TEXT_LENGTH) {
        return { error: `text must be ≤ ${REGEX_EXTRACT_MAX_TEXT_LENGTH} characters` };
      }
      if (!REGEX_EXTRACT_ALLOWED_FLAGS.test(flagsInput)) {
        return { error: "flags must be a subset of g/i/m/s/u/y" };
      }
      // Reject the nested-quantifier catastrophic-backtracking shape BEFORE
      // compiling/running — JS regex can't be timed out on the main thread, so
      // a pattern like (a+)+ against a long string would hang the whole agent.
      if (hasNestedUnboundedQuantifier(pattern)) {
        return { error: "pattern looks vulnerable to catastrophic backtracking (a quantified group whose body is also unbounded, e.g. (a+)+) — simplify it" };
      }
      const flags = flagsInput.includes("g") ? flagsInput : `${flagsInput}g`;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags);
      } catch (error) {
        return { error: `invalid pattern: ${error instanceof Error ? error.message : String(error)}` };
      }
      const matches: string[] = [];
      for (const match of text.matchAll(regex)) {
        const value = match[1] ?? match[0];
        if (typeof value === "string") {
          matches.push(value);
        }
        if (matches.length >= REGEX_EXTRACT_MAX_MATCHES) {
          break;
        }
      }
      return { matches } satisfies JsonObject;
    }
  };
}

