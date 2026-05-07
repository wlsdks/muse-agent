import { createHash, randomUUID } from "node:crypto";
import { readFile as nodeReadFile, readdir as nodeReaddir, stat as nodeStat } from "node:fs/promises";
import { resolve as nodePathResolve, sep as nodePathSep } from "node:path";
import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool, ToolRisk } from "@muse/tools";
import { createMcpMuseTool, type McpConnection, type McpRemoteTool } from "./index.js";

/**
 * Loopback MCP servers — provider-neutral built-in MCP surfaces.
 *
 * The MCP layer in Muse normally connects to external MCP servers over stdio /
 * SSE / streamable HTTP. To prove the MCP path works without external
 * processes (and to ship a JARVIS-style baseline), this module supplies an
 * in-process `McpConnection` adapter plus three reference servers (time,
 * text-utils, math) that operators can register alongside any external MCP
 * server.
 *
 * Each loopback server exposes a curated set of tools whose `execute` runs
 * in-process. They are read-risk by default, deterministic, and require no
 * credentials so they can ship by default.
 */

export interface LoopbackMcpToolDefinition extends McpRemoteTool {
  execute(args: JsonObject): Promise<string | JsonValue> | string | JsonValue;
}

export interface LoopbackMcpServer {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly LoopbackMcpToolDefinition[];
}

/**
 * Wrap a loopback server as an `McpConnection` so the rest of the MCP stack
 * (tool catalog, security policy, MuseTool adapter, span tracer) can treat it
 * exactly like an external MCP server.
 */
export function createLoopbackMcpConnection(server: LoopbackMcpServer): McpConnection {
  const tools = new Map(server.tools.map((tool) => [tool.name, tool] as const));
  return {
    callTool: async (toolName, args) => {
      const tool = tools.get(toolName);
      if (!tool) {
        return `Error: MCP tool '${toolName}' is not registered on '${server.name}'`;
      }
      try {
        const result = await tool.execute(args);
        return result;
      } catch (error) {
        return `Error: MCP tool '${toolName}' on '${server.name}' threw — ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    close: async () => {
      // Loopback servers have no resource to release.
    },
    listTools: async () =>
      server.tools.map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
        name: tool.name,
        ...(tool.risk ? { risk: tool.risk } : {})
      } satisfies McpRemoteTool))
  };
}

/**
 * Convenience: register every tool of the loopback server as a Muse tool with
 * the same `<server>.<tool>` namespacing used by external MCP servers.
 */
export function createLoopbackMcpMuseTools(server: LoopbackMcpServer): readonly MuseTool[] {
  const connection = createLoopbackMcpConnection(server);
  return server.tools.map((tool) =>
    createMcpMuseTool(
      server.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
        name: tool.name,
        ...(tool.risk ? { risk: tool.risk } : {})
      },
      connection
    )
  );
}

export interface BuiltinLoopbackOptions {
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

/** Reference loopback server: read-only time / clock utilities. */
export function createTimeMcpServer(options: BuiltinLoopbackOptions = {}): LoopbackMcpServer {
  const now = options.now ?? (() => new Date());
  return {
    description: "Built-in clock and date utilities (loopback MCP).",
    name: "muse.time",
    tools: [
      {
        description: "Returns the current ISO timestamp, epoch milliseconds, and the resolved IANA timezone.",
        execute: (args): JsonObject => {
          const at = now();
          const timezone = readOptionalString(args, "timezone") ?? "UTC";
          try {
            const formatter = new Intl.DateTimeFormat("en-US", {
              timeZone: timezone,
              weekday: "long"
            });
            return {
              dayOfWeek: formatter.format(at),
              epochMs: at.getTime(),
              iso: at.toISOString(),
              timezone
            } satisfies JsonObject;
          } catch {
            return { error: `unsupported timezone: ${timezone}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            timezone: { type: "string" }
          },
          type: "object"
        },
        name: "now",
        risk: "read"
      },
      {
        description: "Returns the duration in milliseconds from `from` to `to` (negative if `to` precedes `from`).",
        execute: (args): JsonObject => {
          const from = readDate(args, "from");
          const to = readDate(args, "to");
          if (!from || !to) {
            return { error: "from/to must be valid ISO-8601 strings" };
          }
          return { milliseconds: to.getTime() - from.getTime() } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            from: { type: "string" },
            to: { type: "string" }
          },
          required: ["from", "to"],
          type: "object"
        },
        name: "diff_ms",
        risk: "read"
      }
    ]
  };
}

/** Reference loopback server: text utilities. */
export function createTextUtilsMcpServer(): LoopbackMcpServer {
  return {
    description: "Built-in text utilities (loopback MCP).",
    name: "muse.text",
    tools: [
      {
        description: "Returns word, character, and line counts for the input text.",
        execute: (args): JsonObject => {
          const text = readString(args, "text") ?? "";
          if (text.trim().length === 0) {
            return { characters: 0, lines: 0, words: 0 } satisfies JsonObject;
          }
          const words = text.trim().split(/\s+/u).filter((segment) => segment.length > 0).length;
          const lines = text.split(/\r?\n/u).length;
          return { characters: text.length, lines, words } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object"
        },
        name: "stats",
        risk: "read"
      },
      {
        description: "Reverses the input text. Useful for unit tests and sanity checks.",
        execute: (args): JsonObject => {
          const text = readString(args, "text") ?? "";
          return { reversed: [...text].reverse().join("") } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object"
        },
        name: "reverse",
        risk: "read"
      }
    ]
  };
}

const SAFE_MATH_PATTERN = /^[\s\d+\-*/().,%]+$/u;

/** Reference loopback server: arithmetic without `eval`. */
export function createMathMcpServer(): LoopbackMcpServer {
  return {
    description: "Safe arithmetic evaluation (loopback MCP).",
    name: "muse.math",
    tools: [
      {
        description: "Evaluates an arithmetic expression composed of digits, parentheses, +, -, *, /, %.",
        execute: (args): JsonObject => {
          const expression = (readString(args, "expression") ?? "").trim();
          if (expression.length === 0) {
            return { error: "expression is required" };
          }
          if (expression.length > 256) {
            return { error: "expression exceeds 256 character limit" };
          }
          if (!SAFE_MATH_PATTERN.test(expression)) {
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
        },
        inputSchema: {
          additionalProperties: false,
          properties: { expression: { type: "string" } },
          required: ["expression"],
          type: "object"
        },
        name: "evaluate",
        risk: "read"
      }
    ]
  };
}

/** Reference loopback server: JSON utilities for agents reasoning over tool output. */
export function createJsonMcpServer(): LoopbackMcpServer {
  return {
    description: "Built-in JSON utilities (loopback MCP).",
    name: "muse.json",
    tools: [
      {
        description: "Pretty-prints or minifies a JSON string. Mode 'pretty' uses the requested indent (default 2 spaces).",
        execute: (args): JsonObject => {
          const json = readString(args, "json");
          if (json === undefined) {
            return { error: "json is required" };
          }
          const mode = readString(args, "mode") ?? "pretty";
          if (mode !== "pretty" && mode !== "minify") {
            return { error: "mode must be 'pretty' or 'minify'" };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(json);
          } catch (error) {
            return { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
          }
          const indentValue = args.indent;
          const indent = typeof indentValue === "number" && Number.isInteger(indentValue) && indentValue >= 0 && indentValue <= 8
            ? indentValue
            : 2;
          const formatted = mode === "minify" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent);
          return { formatted, mode } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            indent: { type: "integer", minimum: 0, maximum: 8 },
            json: { type: "string" },
            mode: { enum: ["pretty", "minify"], type: "string" }
          },
          required: ["json"],
          type: "object"
        },
        name: "format",
        risk: "read"
      },
      {
        description:
          "Resolves a dot/bracket path against a JSON value. Path syntax: 'foo.bar[0].baz'. Returns { found, value }.",
        execute: (args): JsonObject => {
          const path = readString(args, "path");
          if (path === undefined || path.length === 0) {
            return { error: "path is required" };
          }
          const valueArg = args.value;
          const jsonArg = readString(args, "json");
          let target: unknown;
          if (jsonArg !== undefined) {
            try {
              target = JSON.parse(jsonArg);
            } catch (error) {
              return { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
            }
          } else {
            target = valueArg;
          }
          const segments = parseJsonPath(path);
          if (!segments) {
            return { error: "path is malformed" };
          }
          let cursor: unknown = target;
          for (const segment of segments) {
            if (segment.kind === "key") {
              if (cursor && typeof cursor === "object" && !Array.isArray(cursor) && segment.key in (cursor as Record<string, unknown>)) {
                cursor = (cursor as Record<string, unknown>)[segment.key];
              } else {
                return { found: false, value: null } satisfies JsonObject;
              }
            } else if (Array.isArray(cursor) && segment.index >= 0 && segment.index < cursor.length) {
              cursor = cursor[segment.index];
            } else {
              return { found: false, value: null } satisfies JsonObject;
            }
          }
          return { found: true, value: cursor as JsonValue } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            json: { type: "string" },
            path: { type: "string" },
            value: {}
          },
          required: ["path"],
          type: "object"
        },
        name: "query",
        risk: "read"
      },
      {
        description:
          "Deep-merges two JSON objects. Override keys win; arrays are replaced, not concatenated. Non-object inputs return the override.",
        execute: (args): JsonObject => {
          const base = args.base;
          const overrides = args.overrides;
          if (overrides === undefined) {
            return { error: "overrides is required" };
          }
          return { merged: deepMerge(base, overrides) as JsonValue } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            base: {},
            overrides: {}
          },
          required: ["overrides"],
          type: "object"
        },
        name: "merge",
        risk: "read"
      }
    ]
  };
}

/** Reference loopback server: URL parsing utilities. */
export function createUrlMcpServer(): LoopbackMcpServer {
  return {
    description: "Built-in URL parsing utilities (loopback MCP).",
    name: "muse.url",
    tools: [
      {
        description: "Parses a URL into its components (scheme, host, port, path, query map, hash).",
        execute: (args): JsonObject => {
          const url = readString(args, "url");
          if (url === undefined || url.length === 0) {
            return { error: "url is required" };
          }
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch (error) {
            return { error: `invalid URL: ${error instanceof Error ? error.message : String(error)}` };
          }
          const query: Record<string, string | string[]> = {};
          for (const [key, value] of parsed.searchParams.entries()) {
            const existing = query[key];
            if (existing === undefined) {
              query[key] = value;
            } else if (Array.isArray(existing)) {
              existing.push(value);
            } else {
              query[key] = [existing, value];
            }
          }
          return {
            hash: parsed.hash,
            host: parsed.host,
            hostname: parsed.hostname,
            origin: parsed.origin,
            password: parsed.password,
            pathname: parsed.pathname,
            port: parsed.port,
            protocol: parsed.protocol,
            query: query as JsonValue,
            search: parsed.search,
            username: parsed.username
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { url: { type: "string" } },
          required: ["url"],
          type: "object"
        },
        name: "parse",
        risk: "read"
      },
      {
        description: "Encodes a key/value object as an application/x-www-form-urlencoded query string.",
        execute: (args): JsonObject => {
          const params = args.params;
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return { error: "params must be a JSON object" };
          }
          const search = new URLSearchParams();
          for (const [key, raw] of Object.entries(params as Record<string, unknown>)) {
            if (Array.isArray(raw)) {
              for (const item of raw) {
                search.append(key, String(item));
              }
            } else if (raw !== undefined && raw !== null) {
              search.append(key, String(raw));
            }
          }
          return { query: search.toString() } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { params: { type: "object" } },
          required: ["params"],
          type: "object"
        },
        name: "encode_query",
        risk: "read"
      }
    ]
  };
}

/** Reference loopback server: deterministic crypto digests + base64/hex encoding. */
export function createCryptoMcpServer(options: BuiltinLoopbackOptions = {}): LoopbackMcpServer {
  const supportedAlgorithms = ["md5", "sha1", "sha256", "sha512"] as const;
  return {
    description: "Built-in crypto digest and encoding utilities (loopback MCP).",
    name: "muse.crypto",
    tools: [
      {
        description:
          "Hashes the input string with the requested algorithm (md5, sha1, sha256, sha512). Returns hex digest by default; pass encoding='base64' to get base64.",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          if (text === undefined) {
            return { error: "text is required" };
          }
          const algorithm = (readString(args, "algorithm") ?? "sha256").toLowerCase();
          if (!supportedAlgorithms.includes(algorithm as (typeof supportedAlgorithms)[number])) {
            return { error: `algorithm must be one of ${supportedAlgorithms.join(", ")}` };
          }
          const encoding = readString(args, "encoding") ?? "hex";
          if (encoding !== "hex" && encoding !== "base64") {
            return { error: "encoding must be 'hex' or 'base64'" };
          }
          try {
            const digest = createHash(algorithm).update(text, "utf8").digest(encoding);
            return { algorithm, digest, encoding } satisfies JsonObject;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "hash failed" };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            algorithm: { enum: [...supportedAlgorithms], type: "string" },
            encoding: { enum: ["hex", "base64"], type: "string" },
            text: { type: "string" }
          },
          required: ["text"],
          type: "object"
        },
        name: "hash",
        risk: "read"
      },
      {
        description: "Encodes the input string to base64 (mode='encode') or decodes a base64 string back to UTF-8 (mode='decode').",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          if (text === undefined) {
            return { error: "text is required" };
          }
          const mode = readString(args, "mode") ?? "encode";
          if (mode !== "encode" && mode !== "decode") {
            return { error: "mode must be 'encode' or 'decode'" };
          }
          try {
            if (mode === "encode") {
              return { mode, output: Buffer.from(text, "utf8").toString("base64") } satisfies JsonObject;
            }
            const decoded = Buffer.from(text, "base64").toString("utf8");
            return { mode, output: decoded } satisfies JsonObject;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "base64 failed" };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            mode: { enum: ["encode", "decode"], type: "string" },
            text: { type: "string" }
          },
          required: ["text"],
          type: "object"
        },
        name: "base64",
        risk: "read"
      },
      {
        description: "Encodes the input string to lowercase hex (mode='encode') or decodes a hex string back to UTF-8 (mode='decode').",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          if (text === undefined) {
            return { error: "text is required" };
          }
          const mode = readString(args, "mode") ?? "encode";
          if (mode !== "encode" && mode !== "decode") {
            return { error: "mode must be 'encode' or 'decode'" };
          }
          try {
            if (mode === "encode") {
              return { mode, output: Buffer.from(text, "utf8").toString("hex") } satisfies JsonObject;
            }
            if (!/^[0-9a-fA-F]*$/u.test(text) || text.length % 2 !== 0) {
              return { error: "input is not a valid hex string" };
            }
            return { mode, output: Buffer.from(text, "hex").toString("utf8") } satisfies JsonObject;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "hex failed" };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            mode: { enum: ["encode", "decode"], type: "string" },
            text: { type: "string" }
          },
          required: ["text"],
          type: "object"
        },
        name: "hex",
        risk: "read"
      },
      {
        description: "Generates a fresh RFC 4122 v4 UUID. Uses an injected idFactory for deterministic tests.",
        execute: (): JsonObject => {
          const factory = options.uuid ?? randomUUID;
          return { uuid: factory() } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        name: "uuid",
        risk: "read"
      }
    ]
  };
}

/**
 * Reference loopback server: line-level diff utilities. Uses a deterministic
 * Longest Common Subsequence backtrack so two callers with identical inputs
 * always get the same diff order. Bounded at 2,000 lines per side to keep the
 * O(M*N) DP within ~4MB of memory.
 */
export function createDiffMcpServer(): LoopbackMcpServer {
  const maxLines = 2_000;
  return {
    description: "Built-in line-diff utilities (loopback MCP).",
    name: "muse.diff",
    tools: [
      {
        description:
          "Computes a line-level diff between `left` and `right`. Returns an ordered array of {kind, line} entries where kind is 'equal' / 'insert' (right-only) / 'delete' (left-only). Each entry also carries 1-based leftLine and rightLine indices when applicable.",
        execute: (args): JsonObject => {
          const left = readString(args, "left");
          const right = readString(args, "right");
          if (left === undefined) {
            return { error: "left is required" };
          }
          if (right === undefined) {
            return { error: "right is required" };
          }
          const leftLines = left.split(/\r?\n/u);
          const rightLines = right.split(/\r?\n/u);
          if (leftLines.length > maxLines || rightLines.length > maxLines) {
            return { error: `each side must be at most ${maxLines} lines` };
          }
          const diff = lineDiff(leftLines, rightLines);
          let inserts = 0;
          let deletes = 0;
          for (const entry of diff) {
            if (entry.kind === "insert") {
              inserts += 1;
            } else if (entry.kind === "delete") {
              deletes += 1;
            }
          }
          return {
            deletes,
            diff: diff.map((entry) => ({
              kind: entry.kind,
              line: entry.line,
              ...(entry.leftLine !== undefined ? { leftLine: entry.leftLine } : {}),
              ...(entry.rightLine !== undefined ? { rightLine: entry.rightLine } : {})
            })) as JsonValue,
            equals: diff.length - inserts - deletes,
            inserts
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            left: { type: "string" },
            right: { type: "string" }
          },
          required: ["left", "right"],
          type: "object"
        },
        name: "lines",
        risk: "read"
      },
      {
        description: "Returns true when `left` and `right` are byte-identical, plus the SHA-256 hex digest of each side for quick verification.",
        execute: (args): JsonObject => {
          const left = readString(args, "left");
          const right = readString(args, "right");
          if (left === undefined || right === undefined) {
            return { error: "left and right are required" };
          }
          const leftDigest = createHash("sha256").update(left, "utf8").digest("hex");
          const rightDigest = createHash("sha256").update(right, "utf8").digest("hex");
          return {
            equal: left === right,
            leftDigest,
            rightDigest
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            left: { type: "string" },
            right: { type: "string" }
          },
          required: ["left", "right"],
          type: "object"
        },
        name: "equal",
        risk: "read"
      }
    ]
  };
}

/**
 * Reference loopback server: bounded regex utilities. Input lengths and
 * match counts are capped to keep accidental ReDoS or unbounded fan-out
 * from blocking the event loop. Patterns are also length-bounded so a
 * malicious payload cannot smuggle in pathological regex literals.
 */
export function createRegexMcpServer(): LoopbackMcpServer {
  const maxTextLength = 50_000;
  const maxPatternLength = 256;
  const defaultMaxMatches = 1_000;

  function compile(pattern: string, flags: string | undefined): RegExp | { readonly error: string } {
    if (pattern.length > maxPatternLength) {
      return { error: `pattern must be at most ${maxPatternLength} characters` };
    }
    const safeFlags = (flags ?? "").replace(/[^gimsuy]/gu, "");
    try {
      return new RegExp(pattern, safeFlags);
    } catch (error) {
      return { error: `invalid pattern: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return {
    description: "Built-in bounded regex utilities (loopback MCP).",
    name: "muse.regex",
    tools: [
      {
        description: "Returns true if the pattern matches anywhere in the text. Equivalent to RegExp.test().",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          const pattern = readString(args, "pattern");
          if (text === undefined) {
            return { error: "text is required" };
          }
          if (pattern === undefined) {
            return { error: "pattern is required" };
          }
          if (text.length > maxTextLength) {
            return { error: `text must be at most ${maxTextLength} characters` };
          }
          const regex = compile(pattern, readString(args, "flags"));
          if (regex instanceof RegExp) {
            return { matched: regex.test(text) } satisfies JsonObject;
          }
          return regex;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            flags: { type: "string" },
            pattern: { type: "string" },
            text: { type: "string" }
          },
          required: ["text", "pattern"],
          type: "object"
        },
        name: "test",
        risk: "read"
      },
      {
        description:
          "Returns up to `maxMatches` (default 1000) matches with their index and capture groups. Forces the global flag to enumerate every occurrence.",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          const pattern = readString(args, "pattern");
          if (text === undefined) {
            return { error: "text is required" };
          }
          if (pattern === undefined) {
            return { error: "pattern is required" };
          }
          if (text.length > maxTextLength) {
            return { error: `text must be at most ${maxTextLength} characters` };
          }
          const maxMatchesValue = args.maxMatches;
          const cap =
            typeof maxMatchesValue === "number" && Number.isInteger(maxMatchesValue) && maxMatchesValue > 0
              ? Math.min(maxMatchesValue, defaultMaxMatches * 10)
              : defaultMaxMatches;
          const flags = (readString(args, "flags") ?? "").replace(/[^gimsuy]/gu, "");
          const compiled = compile(pattern, flags.includes("g") ? flags : `${flags}g`);
          if (!(compiled instanceof RegExp)) {
            return compiled;
          }
          const matches: { value: string; index: number; groups?: readonly string[] }[] = [];
          let truncated = false;
          let result: RegExpExecArray | null;
          while ((result = compiled.exec(text)) !== null) {
            if (matches.length >= cap) {
              truncated = true;
              break;
            }
            matches.push({
              groups: result.length > 1 ? result.slice(1).map((value) => value ?? "") : undefined,
              index: result.index,
              value: result[0]
            });
            // Advance on zero-width matches so the loop terminates.
            if (result.index === compiled.lastIndex) {
              compiled.lastIndex += 1;
            }
          }
          return {
            matches: matches.map((entry) => ({
              index: entry.index,
              value: entry.value,
              ...(entry.groups ? { groups: entry.groups as JsonValue } : {})
            })) as JsonValue,
            truncated
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            flags: { type: "string" },
            maxMatches: { type: "integer", minimum: 1 },
            pattern: { type: "string" },
            text: { type: "string" }
          },
          required: ["text", "pattern"],
          type: "object"
        },
        name: "match",
        risk: "read"
      },
      {
        description: "Replaces every match with `replacement`. Forces the global flag so all occurrences are replaced.",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          const pattern = readString(args, "pattern");
          const replacement = readString(args, "replacement");
          if (text === undefined) {
            return { error: "text is required" };
          }
          if (pattern === undefined) {
            return { error: "pattern is required" };
          }
          if (replacement === undefined) {
            return { error: "replacement is required" };
          }
          if (text.length > maxTextLength) {
            return { error: `text must be at most ${maxTextLength} characters` };
          }
          const flags = (readString(args, "flags") ?? "").replace(/[^gimsuy]/gu, "");
          const compiled = compile(pattern, flags.includes("g") ? flags : `${flags}g`);
          if (!(compiled instanceof RegExp)) {
            return compiled;
          }
          return { result: text.replace(compiled, replacement) } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            flags: { type: "string" },
            pattern: { type: "string" },
            replacement: { type: "string" },
            text: { type: "string" }
          },
          required: ["text", "pattern", "replacement"],
          type: "object"
        },
        name: "replace",
        risk: "read"
      }
    ]
  };
}

export interface FetchMcpServerOptions {
  /**
   * Hostnames the fetcher is permitted to reach. Empty by default — opt-in
   * required. The check matches `URL.hostname` exactly (no wildcards). For
   * subdomain support, list each subdomain explicitly.
   */
  readonly allowedHosts: readonly string[];
  /** Hard cap on response body bytes returned to the agent. Default 65,536 (64KB). */
  readonly maxBodyBytes?: number;
  /** Per-request timeout. Default 5,000ms. */
  readonly timeoutMs?: number;
  /** Optional fetch impl override (used in tests). */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Reference loopback server: bounded HTTP GET / HEAD fetcher. Opt-in,
 * allowlist-required, body-capped. Lets JARVIS pull a public document or
 * health-check a known URL without giving it free network access.
 *
 * NOT included in `createDefaultLoopbackMcpServers` — operators who want
 * web fetch must construct it explicitly with the hosts they trust.
 */
export function createFetchMcpServer(options: FetchMcpServerOptions): LoopbackMcpServer {
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const maxBodyBytes = options.maxBodyBytes ?? 65_536;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  function checkAllowed(rawUrl: string): { readonly allowed: true; readonly url: URL } | { readonly allowed: false; readonly error: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      return { allowed: false, error: `invalid URL: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, error: `unsupported protocol: ${parsed.protocol}` };
    }
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
      return { allowed: false, error: `host '${parsed.hostname}' is not in the configured allowlist` };
    }
    return { allowed: true, url: parsed };
  }

  async function callFetch(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url.toString(), { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function headersToObject(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  return {
    description: "Built-in HTTP GET/HEAD fetcher (loopback MCP, allowlist-bounded).",
    name: "muse.fetch",
    tools: [
      {
        description:
          "GETs the URL and returns { status, headers, body, truncated }. URL must be http/https and the hostname must be in the configured allowlist. Body is truncated at maxBodyBytes (default 64KB).",
        execute: async (args): Promise<JsonObject> => {
          const url = readString(args, "url");
          if (url === undefined) {
            return { error: "url is required" };
          }
          const decision = checkAllowed(url);
          if (!decision.allowed) {
            return { error: decision.error };
          }
          const headerEntries = readJsonObject(args, "headers");
          const requestHeaders: Record<string, string> = {};
          if (headerEntries) {
            for (const [key, value] of Object.entries(headerEntries)) {
              if (typeof value === "string") {
                requestHeaders[key] = value;
              }
            }
          }
          try {
            const response = await callFetch(decision.url, { headers: requestHeaders, method: "GET" });
            const fullBody = await response.text();
            const truncated = fullBody.length > maxBodyBytes;
            const body = truncated ? fullBody.slice(0, maxBodyBytes) : fullBody;
            return {
              body,
              headers: headersToObject(response.headers) as JsonValue,
              status: response.status,
              truncated
            } satisfies JsonObject;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `fetch failed: ${message}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            headers: {
              additionalProperties: { type: "string" },
              type: "object"
            },
            url: { type: "string" }
          },
          required: ["url"],
          type: "object"
        },
        name: "get",
        risk: "read"
      },
      {
        description:
          "HEADs the URL and returns { status, headers }. Same allowlist + protocol contract as `get`. Useful for cheap reachability checks without pulling a body.",
        execute: async (args): Promise<JsonObject> => {
          const url = readString(args, "url");
          if (url === undefined) {
            return { error: "url is required" };
          }
          const decision = checkAllowed(url);
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const response = await callFetch(decision.url, { method: "HEAD" });
            return {
              headers: headersToObject(response.headers) as JsonValue,
              status: response.status
            } satisfies JsonObject;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `fetch failed: ${message}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { url: { type: "string" } },
          required: ["url"],
          type: "object"
        },
        name: "head",
        risk: "read"
      }
    ]
  };
}

export interface FilesystemMcpServerOptions {
  /**
   * Absolute paths the filesystem reader is permitted to access. Empty by
   * default — opt-in required. Each root is resolved to an absolute path; a
   * call is allowed only when the requested path resolves to the root itself
   * or a descendant (with a path-separator boundary, so "/etc" never matches
   * "/etc-passwd").
   */
  readonly allowedRoots: readonly string[];
  /** Cap on bytes returned by `read`. Default 65,536 (64KB). */
  readonly maxBodyBytes?: number;
  /** Cap on entries returned by `list`. Default 256. */
  readonly maxListEntries?: number;
  /** Optional fs override (used in tests). Must implement readFile/readdir/stat with the node:fs/promises shape. */
  readonly fs?: {
    readFile(path: string): Promise<Buffer>;
    readdir(path: string, options: { withFileTypes: true }): Promise<readonly { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]>;
    stat(path: string): Promise<{ size: number; mtime: Date; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  };
  /** Optional path module override (used in tests). */
  readonly path?: { resolve(...segments: string[]): string; sep: string };
}

/**
 * Reference loopback server: bounded filesystem reader. Opt-in,
 * allowlist-rooted, body-capped, read-only. Lets JARVIS inspect files inside
 * an operator-defined workspace without giving it free disk access.
 *
 * NOT included in `createDefaultLoopbackMcpServers` — operators who want
 * filesystem access must construct it explicitly with the roots they trust.
 */
export function createFilesystemMcpServer(options: FilesystemMcpServerOptions): LoopbackMcpServer {
  const pathLib = options.path ?? { resolve: nodePathResolve, sep: nodePathSep };
  const fsLib: NonNullable<FilesystemMcpServerOptions["fs"]> = options.fs ?? {
    readFile: (path) => nodeReadFile(path),
    readdir: (path, opts) => nodeReaddir(path, opts) as ReturnType<NonNullable<FilesystemMcpServerOptions["fs"]>["readdir"]>,
    stat: (path) => nodeStat(path)
  };
  const maxBodyBytes = options.maxBodyBytes ?? 65_536;
  const maxListEntries = options.maxListEntries ?? 256;
  const roots = options.allowedRoots.map((root) => pathLib.resolve(root));

  function checkAllowed(rawPath: string): { readonly allowed: true; readonly resolved: string } | { readonly allowed: false; readonly error: string } {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return { allowed: false, error: "path is required" };
    }
    const resolved = pathLib.resolve(rawPath);
    const allowed = roots.some((root) => resolved === root || resolved.startsWith(`${root}${pathLib.sep}`));
    if (!allowed) {
      return { allowed: false, error: `path '${rawPath}' is not under any configured allowlist root` };
    }
    return { allowed: true, resolved };
  }

  function entryKind(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): "directory" | "file" | "symlink" | "other" {
    if (entry.isDirectory()) {
      return "directory";
    }
    if (entry.isFile()) {
      return "file";
    }
    if (entry.isSymbolicLink()) {
      return "symlink";
    }
    return "other";
  }

  return {
    description: "Built-in filesystem reader (loopback MCP, allowlist-rooted, read-only).",
    name: "muse.fs",
    tools: [
      {
        description:
          "Reads a UTF-8 text file inside the configured allowlist and returns { content, bytes, truncated }. Output is truncated at maxBodyBytes (default 64KB). Binary files may produce replacement characters.",
        execute: async (args): Promise<JsonObject> => {
          const decision = checkAllowed(readString(args, "path") ?? "");
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const buffer = await fsLib.readFile(decision.resolved);
            const truncated = buffer.byteLength > maxBodyBytes;
            const slice = truncated ? buffer.subarray(0, maxBodyBytes) : buffer;
            return {
              bytes: buffer.byteLength,
              content: slice.toString("utf8"),
              truncated
            } satisfies JsonObject;
          } catch (error) {
            return { error: `read failed: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        },
        name: "read",
        risk: "read"
      },
      {
        description:
          "Lists the immediate entries of a directory inside the configured allowlist. Returns { entries: [{ name, kind }] } where kind is directory|file|symlink|other. Capped at maxListEntries (default 256).",
        execute: async (args): Promise<JsonObject> => {
          const decision = checkAllowed(readString(args, "path") ?? "");
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const dirents = await fsLib.readdir(decision.resolved, { withFileTypes: true });
            const truncated = dirents.length > maxListEntries;
            const limited = truncated ? dirents.slice(0, maxListEntries) : dirents;
            return {
              entries: limited.map((entry) => ({ kind: entryKind(entry), name: entry.name })) as JsonValue,
              total: dirents.length,
              truncated
            } satisfies JsonObject;
          } catch (error) {
            return { error: `list failed: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        },
        name: "list",
        risk: "read"
      },
      {
        description:
          "Returns metadata for a path inside the configured allowlist: { kind, size, mtime }. mtime is an ISO-8601 string. Symlinks are reported as kind=symlink without following.",
        execute: async (args): Promise<JsonObject> => {
          const decision = checkAllowed(readString(args, "path") ?? "");
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const stats = await fsLib.stat(decision.resolved);
            return {
              kind: entryKind(stats),
              mtime: stats.mtime.toISOString(),
              size: stats.size
            } satisfies JsonObject;
          } catch (error) {
            return { error: `stat failed: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        },
        name: "stat",
        risk: "read"
      }
    ]
  };
}

export interface LoopbackMcpCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly optIn: boolean;
  /** Env hints that operators must set when `optIn` is true. */
  readonly requires?: readonly string[];
  readonly tools: readonly { readonly name: string; readonly description: string; readonly risk: ToolRisk | undefined }[];
}

/**
 * Describes every loopback MCP server Muse ships out of the box — the eight
 * default servers plus the two opt-in ones (`muse.fetch`, `muse.fs`). The
 * catalog is metadata-only (no IO, no construction of opt-in servers), so it
 * is safe to expose via a public discovery endpoint without leaking secrets.
 */
export function describeBuiltinLoopbackMcpServers(): readonly LoopbackMcpCatalogEntry[] {
  const defaults = createDefaultLoopbackMcpServers().map((server): LoopbackMcpCatalogEntry => ({
    description: server.description ?? "",
    name: server.name,
    optIn: false,
    tools: server.tools.map((tool) => ({
      description: tool.description ?? "",
      name: tool.name,
      risk: tool.risk
    }))
  }));

  const fetchServer = createFetchMcpServer({ allowedHosts: [] });
  const fsServer = createFilesystemMcpServer({ allowedRoots: [] });

  const optIn: readonly LoopbackMcpCatalogEntry[] = [
    {
      description: fetchServer.description ?? "",
      name: fetchServer.name,
      optIn: true,
      requires: ["allowedHosts (FetchMcpServerOptions.allowedHosts)"],
      tools: fetchServer.tools.map((tool) => ({
        description: tool.description ?? "",
        name: tool.name,
        risk: tool.risk
      }))
    },
    {
      description: fsServer.description ?? "",
      name: fsServer.name,
      optIn: true,
      requires: ["allowedRoots (FilesystemMcpServerOptions.allowedRoots)"],
      tools: fsServer.tools.map((tool) => ({
        description: tool.description ?? "",
        name: tool.name,
        risk: tool.risk
      }))
    }
  ];

  return [...defaults, ...optIn];
}

/** All eight default loopback servers (time / text / math / json / url / crypto / diff / regex). `muse.fetch` is opt-in via `createFetchMcpServer`. */
export function createDefaultLoopbackMcpServers(options: BuiltinLoopbackOptions = {}): readonly LoopbackMcpServer[] {
  return [
    createTimeMcpServer(options),
    createTextUtilsMcpServer(),
    createMathMcpServer(),
    createJsonMcpServer(),
    createUrlMcpServer(),
    createCryptoMcpServer(options),
    createDiffMcpServer(),
    createRegexMcpServer()
  ];
}

function readJsonObject(args: JsonObject, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

interface DiffEntry {
  readonly kind: "equal" | "insert" | "delete";
  readonly line: string;
  readonly leftLine?: number;
  readonly rightLine?: number;
}

function lineDiff(left: readonly string[], right: readonly string[]): readonly DiffEntry[] {
  const m = left.length;
  const n = right.length;
  // dp[i][j] = LCS length of left[0..i-1] vs right[0..j-1].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  const result: DiffEntry[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      result.push({ kind: "equal", leftLine: i, line: left[i - 1]!, rightLine: j });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      result.push({ kind: "delete", leftLine: i, line: left[i - 1]! });
      i -= 1;
    } else {
      result.push({ kind: "insert", line: right[j - 1]!, rightLine: j });
      j -= 1;
    }
  }
  while (i > 0) {
    result.push({ kind: "delete", leftLine: i, line: left[i - 1]! });
    i -= 1;
  }
  while (j > 0) {
    result.push({ kind: "insert", line: right[j - 1]!, rightLine: j });
    j -= 1;
  }
  return result.reverse();
}

interface JsonPathSegment {
  readonly kind: "key" | "index";
  readonly key: string;
  readonly index: number;
}

function parseJsonPath(path: string): readonly JsonPathSegment[] | undefined {
  const segments: JsonPathSegment[] = [];
  let cursor = 0;
  const trimmed = path.trim().replace(/^\$\.?/u, "");

  while (cursor < trimmed.length) {
    if (trimmed[cursor] === "[") {
      const close = trimmed.indexOf("]", cursor);
      if (close === -1) {
        return undefined;
      }
      const literal = trimmed.slice(cursor + 1, close);
      const numeric = Number.parseInt(literal, 10);
      if (!Number.isInteger(numeric) || String(numeric) !== literal) {
        return undefined;
      }
      segments.push({ index: numeric, key: "", kind: "index" });
      cursor = close + 1;
      if (trimmed[cursor] === ".") {
        cursor += 1;
      }
      continue;
    }

    let end = cursor;
    while (end < trimmed.length && trimmed[end] !== "." && trimmed[end] !== "[") {
      end += 1;
    }
    const key = trimmed.slice(cursor, end);
    if (key.length === 0) {
      return undefined;
    }
    segments.push({ index: -1, key, kind: "key" });
    cursor = end;
    if (trimmed[cursor] === ".") {
      cursor += 1;
    }
  }

  return segments;
}

function deepMerge(base: unknown, overrides: unknown): unknown {
  if (overrides === null || overrides === undefined) {
    return overrides ?? base;
  }
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    return overrides;
  }
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return overrides;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

function readString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDate(args: JsonObject, key: string): Date | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function evaluateArithmetic(expression: string): number {
  let cursor = 0;
  const stripped = expression.replace(/,/gu, "");

  function parseExpression(): number {
    let value = parseTerm();
    while (cursor < stripped.length) {
      skip();
      const ch = stripped[cursor];
      if (ch === "+" || ch === "-") {
        cursor += 1;
        const right = parseTerm();
        value = ch === "+" ? value + right : value - right;
      } else {
        break;
      }
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (cursor < stripped.length) {
      skip();
      const ch = stripped[cursor];
      if (ch === "*" || ch === "/" || ch === "%") {
        cursor += 1;
        const right = parseFactor();
        if (ch === "*") {
          value *= right;
        } else if (ch === "/") {
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
    skip();
    const ch = stripped[cursor];
    if (ch === "+" || ch === "-") {
      cursor += 1;
      const inner = parseFactor();
      return ch === "+" ? inner : -inner;
    }
    if (ch === "(") {
      cursor += 1;
      const value = parseExpression();
      skip();
      if (stripped[cursor] !== ")") {
        throw new Error("unbalanced parentheses");
      }
      cursor += 1;
      return value;
    }
    return parseNumber();
  }

  function parseNumber(): number {
    skip();
    const start = cursor;
    while (cursor < stripped.length) {
      const ch = stripped[cursor] ?? "";
      if ((ch >= "0" && ch <= "9") || ch === ".") {
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

  function skip(): void {
    while (cursor < stripped.length && stripped[cursor] === " ") {
      cursor += 1;
    }
  }

  const value = parseExpression();
  skip();
  if (cursor !== stripped.length) {
    throw new Error("trailing characters after expression");
  }
  return value;
}

// Avoid unused-import warning for the type alias.
export type LoopbackToolRisk = ToolRisk;
