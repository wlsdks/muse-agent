/**
 * `muse.proactive` loopback MCP server — operator-facing audit
 * surface for the proactive surfacing daemon. Mirror of
 * `muse.reminders.history`.
 *
 * Currently exposes a single tool, `history`, which returns the
 * daemon's per-firing audit log so the agent can answer "did the
 * 3pm meeting notice land?" without bouncing through the REST
 * endpoint. The tool is only registered when a `historyFile` is
 * passed (the wider proactive feature has its own env gating;
 * passing the file means autoconfigure already decided the daemon
 * is wired enough to surface audit data).
 */

import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "./loopback.js";
import { readProactiveHistory } from "@muse/stores";

export interface ProactiveMcpServerOptions {
  /** Path to ~/.muse/proactive-history.json. */
  readonly historyFile: string;
}

export function createProactiveMcpServer(options: ProactiveMcpServerOptions): LoopbackMcpServer {
  const historyTool: LoopbackMcpToolDefinition = {
    description:
      "Audit recent proactive surfacing notices. Returns the daemon's per-firing log " +
      "(newest first) with `kind` ('calendar' | 'task'), `itemId`, `title`, `startIso`, " +
      "`providerId`, `destination`, `text`, `firedAtIso`, `status` ('delivered' | 'failed'), " +
      "and `error` on failure. Default limit 100, cap 500. " +
      "Use this to answer 'did the 3pm meeting notice land?' / 'why didn't my Slack heads-up fire?'.",
    execute: async (args: Record<string, unknown>): Promise<JsonObject> => {
      const limitRaw = args["limit"];
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(500, Math.trunc(limitRaw)))
        : undefined;
      try {
        const entries = await readProactiveHistory(options.historyFile, limit);
        return {
          entries: entries as unknown as JsonValue,
          total: entries.length
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: {
          description: "Max entries to return (newest first). Default 100, cap 500.",
          type: "number"
        }
      },
      type: "object"
    },
    domain: "tasks",
    name: "history",
    risk: "read"
  };

  return {
    description:
      "Proactive surfacing audit (calendar + task imminence push). Loopback MCP — readonly history log.",
    name: "muse.proactive",
    tools: [historyTool]
  };
}
