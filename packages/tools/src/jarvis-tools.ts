import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "./index.js";

/**
 * Curated zero-IO JARVIS utility tools that ship with every Muse runtime.
 *
 * Properties:
 * - Pure functions over their inputs (no network, no filesystem, no clock outside `time_*`).
 * - Deterministic given identical inputs (or identical `now()` for time tools).
 * - Safe risk: every tool is a read-only computation.
 * - No vendor coupling — these are the ambient capabilities a JARVIS-style agent should always
 *   have, independent of which model provider, MCP server, or external system is configured.
 *
 * Anything that requires IO belongs in a dedicated tool (e.g. Rust runner, MCP-bridged tool).
 */

export interface JarvisToolFactoryOptions {
  /** Override the wall clock for `time_*` tools. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export function createJarvisTools(options: JarvisToolFactoryOptions = {}): readonly MuseTool[] {
  const now = options.now ?? (() => new Date());
  return [
    createTimeNowTool(now),
    createTimeDiffTool(),
    createTimeAddTool(),
    createTimeRelativeTool(now),
    createTextStatsTool(),
    createMathEvalTool(),
    createJsonQueryTool(),
    createSlugifyTool(),
    createUrlPartsTool(),
    createRegexExtractTool()
  ];
}

function createTimeNowTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Returns the current time as ISO-8601 UTC, epoch milliseconds, day-of-week, and the resolved IANA timezone. " +
        "Useful for stamping events, reasoning about deadlines, and answering 'what time is it' style questions without a network call.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          timezone: {
            description: "Optional IANA timezone (e.g. 'Asia/Seoul', 'UTC'). Defaults to UTC.",
            type: "string"
          }
        },
        type: "object"
      },
      keywords: ["time", "clock", "now", "date"],
      name: "time_now",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const at = now();
      const timezone = readOptionalString(args, "timezone") ?? "UTC";
      let formatted: string;
      let dayOfWeek: string;
      try {
        formatted = new Intl.DateTimeFormat("en-CA", {
          dateStyle: "short",
          timeStyle: "long",
          timeZone: timezone
        }).format(at);
        dayOfWeek = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "long"
        }).format(at);
      } catch {
        return { error: `unsupported timezone: ${timezone}` };
      }
      return {
        dayOfWeek,
        epochMs: at.getTime(),
        formatted,
        iso: at.toISOString(),
        timezone
      } satisfies JsonObject;
    }
  };
}

function createTimeDiffTool(): MuseTool {
  return {
    definition: {
      description:
        "Computes the signed duration between two ISO-8601 timestamps. Returns milliseconds plus a humanized string. " +
        "Negative durations indicate `to` precedes `from`.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          from: { description: "ISO-8601 starting timestamp.", type: "string" },
          to: { description: "ISO-8601 ending timestamp.", type: "string" }
        },
        required: ["from", "to"],
        type: "object"
      },
      keywords: ["time", "duration", "diff", "interval"],
      name: "time_diff",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const from = readRequiredDate(args, "from");
      const to = readRequiredDate(args, "to");
      if (!from || !to) {
        return { error: "from/to must be valid ISO-8601 strings" };
      }
      const ms = to.getTime() - from.getTime();
      return { humanized: humanizeDurationMs(ms), milliseconds: ms } satisfies JsonObject;
    }
  };
}

function createTimeAddTool(): MuseTool {
  return {
    definition: {
      description:
        "Adds a signed duration (`milliseconds`, `seconds`, `minutes`, `hours`, `days`) to a base ISO-8601 timestamp and returns the resulting ISO timestamp. Any combination of fields is summed.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          base: { description: "ISO-8601 base timestamp.", type: "string" },
          days: { type: "number" },
          hours: { type: "number" },
          milliseconds: { type: "number" },
          minutes: { type: "number" },
          seconds: { type: "number" }
        },
        required: ["base"],
        type: "object"
      },
      keywords: ["time", "schedule", "add", "shift"],
      name: "time_add",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const base = readRequiredDate(args, "base");
      if (!base) {
        return { error: "base must be a valid ISO-8601 string" };
      }
      const offsetMs =
        readOptionalNumber(args, "milliseconds") +
        readOptionalNumber(args, "seconds") * 1000 +
        readOptionalNumber(args, "minutes") * 60_000 +
        readOptionalNumber(args, "hours") * 3_600_000 +
        readOptionalNumber(args, "days") * 86_400_000;
      const result = new Date(base.getTime() + offsetMs);
      return { iso: result.toISOString(), offsetMs } satisfies JsonObject;
    }
  };
}

function createTextStatsTool(): MuseTool {
  return {
    definition: {
      description:
        "Returns word, character, and line counts for a string. Whitespace-only inputs return zero counts across all dimensions.",
      inputSchema: {
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object"
      },
      keywords: ["text", "count", "statistics"],
      name: "text_stats",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      if (text.trim().length === 0) {
        return { characters: 0, lines: 0, words: 0 } satisfies JsonObject;
      }
      const words = text.trim().split(/\s+/u).filter((segment) => segment.length > 0);
      const lines = text.split(/\r?\n/u).length;
      return {
        characters: text.length,
        lines,
        words: words.length
      } satisfies JsonObject;
    }
  };
}

const MATH_EXPRESSION = /^[\s\d+\-*/().,%]+$/u;

function createMathEvalTool(): MuseTool {
  return {
    definition: {
      description:
        "Evaluates a numeric arithmetic expression composed of digits, decimal points, parentheses, and the operators + - * / %. Rejects any expression containing other characters; never invokes JavaScript `eval`.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          expression: { description: "Arithmetic expression (e.g. '2 * (3 + 4) / 5').", type: "string" }
        },
        required: ["expression"],
        type: "object"
      },
      keywords: ["math", "calculate", "arithmetic"],
      name: "math_eval",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const expression = typeof args["expression"] === "string" ? (args["expression"] as string).trim() : "";
      if (expression.length === 0) {
        return { error: "expression is required" };
      }
      if (expression.length > 256) {
        return { error: "expression exceeds 256 character limit" };
      }
      if (!MATH_EXPRESSION.test(expression)) {
        return { error: "expression may only contain digits, parentheses, '.', ',' and + - * / %" };
      }
      try {
        const result = evaluateArithmetic(expression);
        if (!Number.isFinite(result)) {
          return { error: "expression evaluated to a non-finite number" };
        }
        return { expression, result } satisfies JsonObject;
      } catch (error) {
        return { error: error instanceof Error ? error.message : "expression evaluation failed" };
      }
    }
  };
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

function createTimeRelativeTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Given an ISO-8601 timestamp `at`, returns a humanized relative phrase ('in 2h', '3d ago', 'just now'), the signed millisecond delta, and a direction ('past' | 'future' | 'now'). " +
        "An optional `reference` ISO timestamp pins the comparison point; otherwise the current clock is used. Useful for surfacing 'when' answers without a follow-up calculation.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          at: { description: "ISO-8601 timestamp to describe.", type: "string" },
          reference: {
            description: "Optional ISO-8601 reference timestamp. Defaults to now.",
            type: "string"
          }
        },
        required: ["at"],
        type: "object"
      },
      keywords: ["time", "relative", "humanize", "ago"],
      name: "time_relative",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const at = readRequiredDate(args, "at");
      if (!at) {
        return { error: "at must be a valid ISO-8601 string" };
      }
      const reference = readRequiredDate(args, "reference") ?? now();
      const deltaMs = at.getTime() - reference.getTime();
      const direction: "past" | "future" | "now" =
        Math.abs(deltaMs) < 1_000 ? "now" : deltaMs > 0 ? "future" : "past";
      const humanized = humanizeRelativeMs(deltaMs);
      return { deltaMs, direction, humanized } satisfies JsonObject;
    }
  };
}

function createSlugifyTool(): MuseTool {
  return {
    definition: {
      description:
        "Converts free-form `text` into a URL-safe slug: lowercased, with non-alphanumeric runs collapsed to a single '-' and leading/trailing dashes stripped. Optional `maxLength` truncates and re-trims. Empty / whitespace-only inputs return 'untitled'.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          maxLength: {
            description: "Optional positive integer cap on the slug length.",
            type: "number"
          },
          text: { description: "Source text to slugify.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["slug", "url", "filename", "identifier"],
      name: "slugify",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      const cap = readOptionalNumber(args, "maxLength");
      const maxLength = Number.isInteger(cap) && cap > 0 ? cap : undefined;
      return { slug: slugify(text, maxLength) } satisfies JsonObject;
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

function readOptionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRequiredDate(args: JsonObject, key: string): Date | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readOptionalNumber(args: JsonObject, key: string): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function humanizeRelativeMs(ms: number): string {
  const absolute = Math.abs(ms);
  if (absolute < 1_000) {
    return "just now";
  }
  const days = Math.floor(absolute / 86_400_000);
  const hours = Math.floor((absolute % 86_400_000) / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const segments: string[] = [];
  if (days > 0) {
    segments.push(`${days}d`);
  }
  if (hours > 0 && days < 2) {
    segments.push(`${hours}h`);
  }
  if (minutes > 0 && days === 0) {
    segments.push(`${minutes}m`);
  }
  if (segments.length === 0) {
    segments.push(`${seconds}s`);
  }
  const unit = segments.join(" ");
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

function slugify(text: string, maxLength?: number): string {
  const trimmed = text.normalize("NFKD").replace(/[̀-ͯ]/gu, "");
  const reduced = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (reduced.length === 0) {
    return "untitled";
  }
  if (maxLength === undefined || reduced.length <= maxLength) {
    return reduced;
  }
  const truncated = reduced.slice(0, maxLength).replace(/-+$/u, "");
  return truncated.length > 0 ? truncated : reduced.slice(0, maxLength);
}

function humanizeDurationMs(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const absolute = Math.abs(ms);
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const millis = absolute % 1_000;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 && hours === 0) {
    parts.push(`${seconds}s`);
  }
  if (parts.length === 0) {
    parts.push(`${millis}ms`);
  }
  return `${sign}${parts.join(" ")}`;
}

/**
 * Recursive-descent arithmetic evaluator for the constrained character set enforced upstream.
 * Implements operator precedence (* / % before + -), supports parentheses, and rejects empty
 * subexpressions. Avoids `eval` / `Function` for safety.
 */
function evaluateArithmetic(expression: string): number {
  let cursor = 0;
  const stripped = expression.replace(/,/gu, "");

  function parseExpression(): number {
    let value = parseTerm();
    while (cursor < stripped.length) {
      skipWhitespace();
      const char = stripped[cursor];
      if (char === "+" || char === "-") {
        cursor += 1;
        const right = parseTerm();
        value = char === "+" ? value + right : value - right;
      } else {
        break;
      }
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (cursor < stripped.length) {
      skipWhitespace();
      const char = stripped[cursor];
      if (char === "*" || char === "/" || char === "%") {
        cursor += 1;
        const right = parseFactor();
        if (char === "*") {
          value *= right;
        } else if (char === "/") {
          if (right === 0) {
            throw new Error("division by zero");
          }
          value /= right;
        } else {
          if (right === 0) {
            throw new Error("modulo by zero");
          }
          value %= right;
        }
      } else {
        break;
      }
    }
    return value;
  }

  function parseFactor(): number {
    skipWhitespace();
    const char = stripped[cursor];
    if (char === "+" || char === "-") {
      cursor += 1;
      const inner = parseFactor();
      return char === "+" ? inner : -inner;
    }
    if (char === "(") {
      cursor += 1;
      const value = parseExpression();
      skipWhitespace();
      if (stripped[cursor] !== ")") {
        throw new Error("unbalanced parentheses");
      }
      cursor += 1;
      return value;
    }
    return parseNumber();
  }

  function parseNumber(): number {
    skipWhitespace();
    const start = cursor;
    while (cursor < stripped.length) {
      const char = stripped[cursor] ?? "";
      if ((char >= "0" && char <= "9") || char === ".") {
        cursor += 1;
      } else {
        break;
      }
    }
    if (cursor === start) {
      throw new Error("expected number");
    }
    const literal = stripped.slice(start, cursor);
    const value = Number.parseFloat(literal);
    if (Number.isNaN(value)) {
      throw new Error(`invalid number literal: ${literal}`);
    }
    return value;
  }

  function skipWhitespace(): void {
    while (cursor < stripped.length && stripped[cursor] === " ") {
      cursor += 1;
    }
  }

  const value = parseExpression();
  skipWhitespace();
  if (cursor !== stripped.length) {
    throw new Error("trailing characters after expression");
  }
  return value;
}
