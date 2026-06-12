import type { JsonObject, JsonValue } from "@muse/shared";

import { readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";

/**
 * `muse.json` JSON utilities — pretty/minify, dot/bracket-path
 * query, deep-merge. Lifted out of `loopback.ts` together with
 * the private `parseJsonPath` + `deepMerge` helpers and the
 * `JsonPathSegment` shape.
 */

interface JsonPathSegment {
  readonly kind: "key" | "index";
  readonly key: string;
  readonly index: number;
}

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
              // Object.hasOwn, NOT `key in cursor`: `in` walks the prototype chain, so a
              // path of `constructor` / `__proto__` / `toString` resolved to an inherited
              // value (a function / Object.prototype) and leaked it into the tool result.
              if (cursor && typeof cursor === "object" && !Array.isArray(cursor) && Object.hasOwn(cursor as Record<string, unknown>, segment.key)) {
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
    if (key === "__proto__") {
      // Model args arrive via JSON.parse, which makes "__proto__" an OWN data key.
      // A plain `result["__proto__"] = …` would hit the Object.prototype setter and
      // HIJACK the merged object's prototype (a prototype-pollution vector: silently
      // injects inherited fields and drops the key). Merge it as an own data property.
      const existing = Object.getOwnPropertyDescriptor(result, key)?.value;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: deepMerge(existing, value),
        writable: true
      });
      continue;
    }
    result[key] = deepMerge(result[key], value);
  }
  return result;
}
