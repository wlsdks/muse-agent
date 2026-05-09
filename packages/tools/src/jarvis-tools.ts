import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
    createNextWeekdayTool(now),
    createTextStatsTool(),
    createMathEvalTool(),
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

const KV_SUMMARIZE_MAX_LINES = 200;

function createKvSummarizeTool(): MuseTool {
  return {
    definition: {
      description:
        "Flattens a JSON object into a `key: value` newline-joined summary. Nested keys are joined with `.`, array indices appear as `.0`, `.1`. Strings, numbers, booleans, and null render directly; nested arrays/objects recurse. Capped at 200 lines (the rest are dropped with a trailing `…(N more)` line). " +
        "Useful when piping a structured tool result into a prose answer without imposing JSON syntax on the model.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          data: { description: "JSON object or array to flatten.", type: "object" }
        },
        required: ["data"],
        type: "object"
      },
      keywords: ["summarize", "flatten", "kv", "format"],
      name: "kv_summarize",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const data = args["data"];
      if (data === undefined || data === null) {
        return { summary: "" };
      }
      const lines: string[] = [];
      let truncated = 0;
      flattenIntoKv(data as JsonValue, "", (line) => {
        if (lines.length >= KV_SUMMARIZE_MAX_LINES) {
          truncated += 1;
          return;
        }
        lines.push(line);
      });
      if (truncated > 0) {
        lines.push(`…(${truncated} more)`);
      }
      return { summary: lines.join("\n") } satisfies JsonObject;
    }
  };
}

function flattenIntoKv(value: JsonValue, prefix: string, emit: (line: string) => void): void {
  if (value === null || value === undefined) {
    emit(`${prefix || "value"}: null`);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    emit(`${prefix || "value"}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      emit(`${prefix || "value"}: []`);
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index] ?? null;
      const nextPrefix = prefix.length > 0 ? `${prefix}.${index}` : String(index);
      flattenIntoKv(child as JsonValue, nextPrefix, emit);
    }
    return;
  }
  const entries = Object.entries(value as Record<string, JsonValue | null>);
  if (entries.length === 0) {
    emit(`${prefix || "value"}: {}`);
    return;
  }
  for (const [key, child] of entries) {
    const nextPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
    flattenIntoKv((child ?? null) as JsonValue, nextPrefix, emit);
  }
}

const MARKDOWN_TABLE_MAX_ROWS = 200;

function createMarkdownTableTool(): MuseTool {
  return {
    definition: {
      description:
        "Renders an array of plain JSON objects as a GitHub-flavored markdown table. " +
        "Columns default to the union of keys from the first 50 rows in first-appearance order; pass `columns` to constrain or reorder them. " +
        "Cell values render via String(); pipes and newlines in cells are escaped (`\\|` and `<br/>`). Empty input returns an empty table header. " +
        "Capped at 200 rows; the rest are dropped with a trailing `_…N more rows omitted_` line.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          columns: {
            description: "Optional explicit column order. When omitted, derives from the rows.",
            items: { type: "string" },
            type: "array"
          },
          rows: {
            description: "Array of plain objects to render.",
            items: { type: "object" },
            type: "array"
          }
        },
        required: ["rows"],
        type: "object"
      },
      keywords: ["markdown", "table", "format"],
      name: "markdown_table",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const rawRows = Array.isArray(args["rows"]) ? (args["rows"] as readonly unknown[]) : [];
      const explicitColumns = Array.isArray(args["columns"])
        ? (args["columns"] as readonly unknown[]).filter((entry): entry is string => typeof entry === "string")
        : undefined;
      const rows: Array<Record<string, unknown>> = [];
      for (const entry of rawRows) {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          rows.push(entry as Record<string, unknown>);
        }
      }
      const columns = explicitColumns && explicitColumns.length > 0
        ? Array.from(new Set(explicitColumns))
        : deriveMarkdownTableColumns(rows);
      if (columns.length === 0) {
        return { markdown: "" } satisfies JsonObject;
      }
      const lines: string[] = [];
      lines.push(`| ${columns.join(" | ")} |`);
      lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
      const truncated = Math.max(0, rows.length - MARKDOWN_TABLE_MAX_ROWS);
      const visibleRows = truncated > 0 ? rows.slice(0, MARKDOWN_TABLE_MAX_ROWS) : rows;
      for (const row of visibleRows) {
        const cells = columns.map((column) => formatMarkdownTableCell(row[column]));
        lines.push(`| ${cells.join(" | ")} |`);
      }
      if (truncated > 0) {
        lines.push(`_…${truncated} more rows omitted_`);
      }
      return { markdown: lines.join("\n") } satisfies JsonObject;
    }
  };
}

function deriveMarkdownTableColumns(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (let index = 0; index < rows.length && index < 50; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function formatMarkdownTableCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br/>");
}

const HASH_TEXT_ALGORITHMS = new Set(["sha256", "sha1", "md5"]);

function createHashTextTool(): MuseTool {
  return {
    definition: {
      description:
        "Computes a hex digest of `text` using `algorithm` (sha256 default; also accepts sha1, md5). " +
        "Useful for deduplicating notes, generating deterministic IDs from user content, fingerprinting attached payloads, or comparing two strings without leaking the original. " +
        "Hashes the UTF-8 bytes of the input.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          algorithm: {
            description: "Hash algorithm (sha256, sha1, md5). Defaults to sha256.",
            type: "string"
          },
          text: { description: "Source text.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["hash", "fingerprint", "dedupe", "sha256"],
      name: "hash_text",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      const algorithmInput = typeof args["algorithm"] === "string"
        ? (args["algorithm"] as string).trim().toLowerCase()
        : "sha256";
      const algorithm = algorithmInput.length === 0 ? "sha256" : algorithmInput;
      if (!HASH_TEXT_ALGORITHMS.has(algorithm)) {
        return { error: `algorithm must be one of: sha256, sha1, md5 (got '${algorithm}')` };
      }
      const digest = createHash(algorithm).update(text, "utf8").digest("hex");
      return { algorithm, digest } satisfies JsonObject;
    }
  };
}

const CSV_PARSE_MAX_ROWS = 1_000;
const CSV_PARSE_MAX_TEXT_LENGTH = 200_000;

function createCsvParseTool(): MuseTool {
  return {
    definition: {
      description:
        "Parses CSV `text` into structured rows. With `header: true` (default), the first non-empty record becomes the column names and each remaining record returns as an object keyed by those names; `headers` is included on the response. With `header: false`, every record returns as an array of strings under `rows`. " +
        "Handles quoted fields, escaped quotes (`\"\"` → `\"`), CRLF/LF line endings, and trailing empty fields. Bounded inputs: text ≤ 200k characters, ≤ 1000 records.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          header: {
            description: "When true (default), parse the first row as headers and return objects.",
            type: "boolean"
          },
          text: { description: "CSV-formatted text.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["csv", "parse", "spreadsheet", "table"],
      name: "csv_parse",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      if (text.length === 0) {
        return { rows: [] } satisfies JsonObject;
      }
      if (text.length > CSV_PARSE_MAX_TEXT_LENGTH) {
        return { error: `text must be ≤ ${CSV_PARSE_MAX_TEXT_LENGTH} characters` };
      }
      const useHeader = args["header"] === false ? false : true;
      const records = parseCsvRecords(text);
      if (useHeader) {
        if (records.length === 0) {
          return { headers: [], rows: [] } satisfies JsonObject;
        }
        const headers = records[0] ?? [];
        const dataRecords = records.slice(1, 1 + CSV_PARSE_MAX_ROWS);
        const rows = dataRecords.map((record) => {
          const row: Record<string, string> = {};
          for (let index = 0; index < headers.length; index += 1) {
            row[headers[index] ?? ""] = record[index] ?? "";
          }
          return row;
        });
        return { headers, rows } satisfies JsonObject;
      }
      return { rows: records.slice(0, CSV_PARSE_MAX_ROWS) } satisfies JsonObject;
    }
  };
}

const BASE64_MAX_TEXT_LENGTH = 500_000;

function createBase64Tool(): MuseTool {
  return {
    definition: {
      description:
        "Encodes UTF-8 `text` to base64 (`mode: 'encode'`) or decodes base64 `text` back to UTF-8 (`mode: 'decode'`). " +
        "With `urlSafe: true`, encodes to URL-safe base64 (replaces '+' / '/' with '-' / '_' and drops '=' padding) and accepts URL-safe input on decode. " +
        "Useful for inspecting JWT segments, building basic-auth headers, decoding opaque tokens, and round-tripping notes through ASCII-only transports. Bounded inputs: text ≤ 500k characters.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          mode: { description: "'encode' or 'decode'.", type: "string" },
          text: { description: "UTF-8 source for encode; base64 source for decode.", type: "string" },
          urlSafe: { description: "Use URL-safe alphabet ('-' and '_', no padding). Defaults to false.", type: "boolean" }
        },
        required: ["mode", "text"],
        type: "object"
      },
      keywords: ["base64", "encode", "decode", "jwt", "transport"],
      name: "base64",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const mode = typeof args["mode"] === "string" ? (args["mode"] as string).trim().toLowerCase() : "";
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      const urlSafe = args["urlSafe"] === true;

      if (mode !== "encode" && mode !== "decode") {
        return { error: "mode must be 'encode' or 'decode'" };
      }

      if (text.length > BASE64_MAX_TEXT_LENGTH) {
        return { error: `text must be ≤ ${BASE64_MAX_TEXT_LENGTH} characters` };
      }

      if (mode === "encode") {
        const standard = Buffer.from(text, "utf8").toString("base64");
        const encoded = urlSafe
          ? standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
          : standard;
        return { encoded } satisfies JsonObject;
      }

      const trimmed = text.trim();
      const expectedAlphabet = urlSafe ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
      if (!expectedAlphabet.test(trimmed)) {
        return { error: urlSafe ? "input is not valid url-safe base64" : "input is not valid base64" };
      }
      const standardised = urlSafe
        ? padBase64(trimmed.replace(/-/g, "+").replace(/_/g, "/"))
        : trimmed;
      const buffer = Buffer.from(standardised, "base64");
      const reEncoded = buffer.toString("base64").replace(/=+$/, "");
      if (reEncoded !== standardised.replace(/=+$/, "")) {
        return { error: "input is not valid base64" };
      }
      return { decoded: buffer.toString("utf8") } satisfies JsonObject;
    }
  };
}

function padBase64(input: string): string {
  const remainder = input.length % 4;
  return remainder === 0 ? input : input + "=".repeat(4 - remainder);
}

function createCronForDatetimeTool(): MuseTool {
  return {
    definition: {
      description:
        "Converts an ISO-8601 datetime to a cron expression for the scheduler. " +
        "`mode` controls the recurrence: 'once' (default) returns a yearly-recurring expression at that exact minute/hour/day/month — disable the scheduled job after it fires for true one-shot semantics; 'daily' fires every day at that hour:minute; 'weekly' fires every week on that weekday at that hour:minute; 'monthly' fires every month on that day-of-month at that hour:minute. " +
        "Bridge for natural-language reminders: compose with `time_now` + `time_add` / `next_weekday` / `time_relative` to build the ISO, then pass it here, then call `scheduler_create_job` with the returned cron.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          iso: { description: "ISO-8601 datetime (UTC).", type: "string" },
          mode: {
            description: "'once' | 'daily' | 'weekly' | 'monthly'. Defaults to 'once'.",
            type: "string"
          }
        },
        required: ["iso"],
        type: "object"
      },
      keywords: ["cron", "schedule", "reminder", "datetime", "scheduler"],
      name: "cron_for_datetime",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const isoInput = typeof args["iso"] === "string" ? (args["iso"] as string).trim() : "";
      const modeInput = typeof args["mode"] === "string" ? (args["mode"] as string).trim().toLowerCase() : "once";
      const mode = modeInput.length === 0 ? "once" : modeInput;

      if (!CRON_DATETIME_MODES.has(mode)) {
        return { error: `mode must be one of: once, daily, weekly, monthly (got '${mode}')` };
      }

      if (!isoInput) {
        return { error: "iso is required" };
      }

      const at = new Date(isoInput);

      if (Number.isNaN(at.getTime())) {
        return { error: `invalid ISO-8601 datetime: '${isoInput}'` };
      }

      const minute = at.getUTCMinutes();
      const hour = at.getUTCHours();
      const dayOfMonth = at.getUTCDate();
      const month = at.getUTCMonth() + 1;
      const dayOfWeek = at.getUTCDay();

      let cron: string;
      switch (mode) {
        case "daily":
          cron = `${minute} ${hour} * * *`;
          break;
        case "weekly":
          cron = `${minute} ${hour} * * ${dayOfWeek}`;
          break;
        case "monthly":
          cron = `${minute} ${hour} ${dayOfMonth} * *`;
          break;
        default:
          cron = `${minute} ${hour} ${dayOfMonth} ${month} *`;
          break;
      }

      return { cron, iso: at.toISOString(), mode } satisfies JsonObject;
    }
  };
}

const CRON_DATETIME_MODES = new Set(["once", "daily", "weekly", "monthly"]);

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (character === "\r") {
      if (text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    if (character === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

const WEEKDAY_NAMES: ReadonlyArray<readonly string[]> = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"]
];

function createNextWeekdayTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Resolves a weekday name (e.g. 'Monday' / 'mon' / 'TUES') to the next ISO date on which it falls. " +
        "Optional `reference` (ISO-8601) pins the comparison point; otherwise the current clock is used. " +
        "If the reference is itself that weekday, returns the occurrence one week later (always a strict 'next'). " +
        "Returns `{ iso, weekday }` (UTC date stripped of time-of-day) so the agent can stamp reminders or compose schedules without inline math.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          reference: {
            description: "Optional ISO-8601 reference timestamp. Defaults to now.",
            type: "string"
          },
          weekday: {
            description: "Weekday name or 3-letter abbreviation (case-insensitive).",
            type: "string"
          }
        },
        required: ["weekday"],
        type: "object"
      },
      keywords: ["calendar", "schedule", "weekday", "next"],
      name: "next_weekday",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const weekdayInput = typeof args["weekday"] === "string" ? (args["weekday"] as string).trim().toLowerCase() : "";
      if (weekdayInput.length === 0) {
        return { error: "weekday is required" };
      }
      const targetIndex = WEEKDAY_NAMES.findIndex((aliases) => aliases.includes(weekdayInput));
      if (targetIndex < 0) {
        return { error: `weekday must be one of: ${WEEKDAY_NAMES.map((aliases) => aliases[0]).join(", ")}` };
      }
      const reference = readRequiredDate(args, "reference") ?? now();
      const referenceDay = new Date(Date.UTC(
        reference.getUTCFullYear(),
        reference.getUTCMonth(),
        reference.getUTCDate()
      ));
      const currentIndex = referenceDay.getUTCDay();
      let delta = (targetIndex - currentIndex + 7) % 7;
      if (delta === 0) {
        delta = 7;
      }
      const next = new Date(referenceDay.getTime() + delta * 86_400_000);
      const iso = next.toISOString().slice(0, 10);
      const weekdayName = WEEKDAY_NAMES[targetIndex]?.[0] ?? weekdayInput;
      return { iso, weekday: weekdayName } satisfies JsonObject;
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
