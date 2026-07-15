/**
 * `muse.context` loopback MCP server — agent-callable surface over
 * the `ContextReferenceStore` (Context Engineering 1.d)
 * and the Phase-1 `ActiveContextProvider`.
 *
 * Tools:
 *   - `muse.context.fetch({ ref })` — return the full content
 *     stashed under `ref`. The marker emitted by tool-output
 *  truncation is the typical `ref` source. Returns
 *     `{ found: false }` when the ref is unknown / expired.
 *   - `muse.context.list()` — enumerate currently-cached refs with
 *     their source tool, `originalLength`, and `createdAt`. Useful
 *     for the agent (or a debugger UI) to see what's available
 *     without fetching every blob.
 *   - `muse.context.active({ userId?, sessionId? })` — resolve the
 *     same `[Active Context]` snapshot the runtime injects into the
 *     system prompt. Only registered when an `activeContextProvider`
 *     is wired (i.e. `MUSE_ACTIVE_CONTEXT_ENABLED !== "false"`).
 *
 * The store is in-process: refs survive only within the same
 * server. Cross-process sharing is intentionally out of scope —
 * the references are an inference-time scratchpad, not a
 * persistent cache.
 */

import type { JsonObject, JsonValue } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "@muse/mcp";
import type { ContextReferenceStore } from "@muse/memory";

/**
 * Minimal structural shape of `ActiveContextProvider` from
 * `@muse/agent-core`. Duplicated here to avoid making `@muse/mcp`
 * depend on `@muse/agent-core` (which would tighten the dep graph
 * for one method). `autoconfigure` passes the real provider in.
 */
interface ActiveContextProviderLike {
  resolve(
    options?: { readonly userId?: string; readonly sessionId?: string } | string
  ): Promise<unknown> | unknown;
}

export interface ContextReferenceMcpServerOptions {
  readonly store: ContextReferenceStore;
  /**
   * When provided, the server exposes `muse.context.active` so the
   * agent can read its own Phase-1 snapshot without trusting the
   * cached `[Active Context]` block in the system prompt to still
   * be accurate (e.g., after a long tool loop the clock moved).
   */
  readonly activeContextProvider?: ActiveContextProviderLike;
}

export function createContextReferenceMcpServer(
  options: ContextReferenceMcpServerOptions
): LoopbackMcpServer {
  const { store, activeContextProvider } = options;
  const activeTool: LoopbackMcpToolDefinition[] = activeContextProvider
    ? [
        {
          description:
            "Resolve the current `[Active Context]` snapshot (time, weekday, timezone, " +
            "working-hours, active task, today's calendar events). Pass userId + sessionId " +
            "to pick up the same per-user preferences the runtime uses when composing the " +
            "system prompt.",
          execute: async (args): Promise<JsonObject> => {
            const userId = readString(args, "userId")?.trim();
            const sessionId = readString(args, "sessionId")?.trim();
            const snapshot = await activeContextProvider.resolve({
              ...(userId ? { userId } : {}),
              ...(sessionId ? { sessionId } : {})
            });
            if (!snapshot) {
              return { found: false };
            }
            return { found: true, snapshot: sanitizeJsonValue(snapshot) };
          },
          inputSchema: {
            additionalProperties: false,
            properties: {
              sessionId: { description: "Session id to resolve the active context for (default: the current session).", type: "string" },
              userId: { description: "User id whose active context to resolve (default: the current user).", type: "string" }
            },
            type: "object"
          },
          domain: "core",
          name: "active",
          risk: "read"
        }
      ]
    : [];

  return {
    description: "Server-side reference cache for large tool outputs + Phase-1 active-context resolver.",
    name: "muse.context",
    tools: [
      {
        description:
          "Fetch the full content stashed under a reference id. " +
          "When tool output is truncated, its marker includes a `ref=<id>` hint — pass that id here to expand.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "ref")?.trim();
          if (!ref) {
            return { error: "ref is required" };
          }
          const entry = store.get(ref);
          if (!entry) {
            return { found: false, ref };
          }
          return {
            content: entry.content,
            ...(entry.contentType ? { contentType: entry.contentType } : {}),
            createdAt: entry.createdAt.toISOString(),
            found: true,
            ref: entry.id,
            ...(entry.source ? { source: entry.source } : {}),
            ...(typeof entry.originalLength === "number" ? { originalLength: entry.originalLength } : {})
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            ref: { description: "Reference id from a truncated tool output's `ref=<id>` marker.", type: "string" }
          },
          required: ["ref"],
          type: "object"
        },
        domain: "core",
        name: "fetch",
        risk: "read"
      },
      {
        description:
          "List currently-cached reference ids without fetching their bodies. " +
          "Useful before deciding which `fetch(ref)` is worth the budget.",
        execute: async (): Promise<JsonObject> => {
          const refs = store.list().map((entry) => ({
            createdAt: entry.createdAt.toISOString(),
            id: entry.id,
            ...(entry.contentType ? { contentType: entry.contentType } : {}),
            ...(typeof entry.originalLength === "number" ? { originalLength: entry.originalLength } : {}),
            ...(entry.source ? { source: entry.source } : {})
          }));
          return {
            refs,
            total: refs.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        domain: "core",
        name: "list",
        risk: "read"
      },
      ...activeTool
    ]
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof key === "string") record[key] = entryValue;
  }
  return record;
}

function sanitizeJsonValue(value: unknown): JsonValue {
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
    return value.map(sanitizeJsonValue);
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    const record = toRecord(value);
    if (!record) {
      return null;
    }
    for (const [key, entryValue] of Object.entries(record)) {
      out[key] = sanitizeJsonValue(entryValue);
    }
    return out;
  }
  return String(value);
}
