import { isRecord, type JsonObject } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";

/**
 * `muse.url` URL parsing + query encoding. Lifted out of
 * `loopback.ts`.
 */

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
          // Null-prototype map: a `__proto__` or `constructor` query param must land as
          // a plain DATA key, not hit the prototype setter (pollution + the param vanishing)
          // or collide with the inherited Object constructor (corrupting the dedup). The
          // `existing === undefined` check below then works for EVERY key.
          const query: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
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
            query,
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
          if (!isRecord(params)) {
            return { error: "params must be a JSON object" };
          }
          const isScalar = (v: unknown): v is string | number | boolean =>
            typeof v === "string" || typeof v === "number" || typeof v === "boolean";
          const search = new URLSearchParams();
          for (const [key, raw] of Object.entries(params)) {
            if (Array.isArray(raw)) {
              for (const item of raw) {
                // Skip null/undefined items, exactly as the scalar branch below does —
                // otherwise String(null) leaks a corrupt `key=null` param.
                if (item === null || item === undefined) {
                  continue;
                }
                // A nested object/array would String()-coerce to "[object Object]" — a
                // silently corrupt query param. Reject it instead of encoding garbage.
                if (!isScalar(item)) {
                  return { error: `params['${key}'] array items must be string/number/boolean, not a nested object/array` };
                }
                search.append(key, String(item));
              }
            } else if (raw !== undefined && raw !== null) {
              if (!isScalar(raw)) {
                return { error: `params['${key}'] must be a string/number/boolean or an array of those, not a nested object` };
              }
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
