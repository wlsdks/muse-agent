import type { JsonObject, JsonValue } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";

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
          const root = toJsonValue(target);
          const segments = parseJsonPath(path);
          if (!segments) {
            return { error: "path is malformed" };
          }
          let cursor: JsonValue = root;
          for (const segment of segments) {
            if (segment.kind === "key") {
              // Object.hasOwn, NOT `key in cursor`: `in` walks the prototype chain, so a
              // path of `constructor` / `__proto__` / `toString` resolved to an inherited
              // value (a function / Object.prototype) and leaked it into the tool result.
              if (cursor && isJsonObject(cursor) && Object.hasOwn(cursor, segment.key)) {
                cursor = cursor[segment.key];
              } else {
                return { found: false, value: null } satisfies JsonObject;
              }
            } else if (Array.isArray(cursor) && segment.index >= 0 && segment.index < cursor.length) {
              cursor = cursor[segment.index];
            } else {
              return { found: false, value: null } satisfies JsonObject;
            }
          }
          return { found: true, value: cursor } satisfies JsonObject;
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
          const baseValue = toJsonValue(base);
          const overridesValue = toJsonValue(overrides);
          return { merged: deepMerge(baseValue, overridesValue) } satisfies JsonObject;
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

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    if (!isJsonObject(value)) {
      return null;
    }
    for (const [key, nested] of Object.entries(value)) {
      out[key] = toJsonValue(nested);
    }
    return out;
  }
  return String(value);
}

function deepMerge(base: JsonValue, overrides: JsonValue): JsonValue {
  if (overrides === null) {
    return overrides;
  }
  if (!isJsonObject(overrides) || Array.isArray(overrides)) {
    return overrides;
  }
  if (!isJsonObject(base)) {
    return overrides;
  }
  if (Array.isArray(base)) {
    return overrides;
  }
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "__proto__") {
      // Model args arrive via JSON.parse, which makes "__proto__" an OWN data key.
      // A plain `result["__proto__"] = …` would hit the Object.prototype setter and
      // HIJACK the merged object's prototype (a prototype-pollution vector: silently
      // injects inherited fields and drops the key). Merge it as an own data property.
      const existing = Object.getOwnPropertyDescriptor(result, key)?.value;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: deepMerge(toJsonValue(existing), toJsonValue(value)),
        writable: true
      });
      continue;
    }
    result[key] = deepMerge(result[key], toJsonValue(value));
  }
  return result;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
