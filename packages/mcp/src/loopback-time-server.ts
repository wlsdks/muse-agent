import type { JsonObject } from "@muse/shared";

import { buildJsonToolSchema } from "./loopback-helpers.js";
import type { BuiltinLoopbackOptions, LoopbackMcpServer } from "./loopback.js";

/**
 * `muse.time` clock + date utilities — `now` (timezone-aware ISO +
 * day-of-week) and `diff_ms` (signed millisecond delta between two
 * ISO timestamps). Lifted out of `loopback.ts` together with its
 * `readDate` / `readOptionalString` helpers.
 */

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
        inputSchema: buildJsonToolSchema({ timezone: { type: "string" } }),
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
        inputSchema: buildJsonToolSchema(
          { from: { type: "string" }, to: { type: "string" } },
          ["from", "to"]
        ),
        name: "diff_ms",
        risk: "read"
      }
    ]
  };
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
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  // `new Date("2026-02-30")` silently rolls over to Mar 2 — accepting it would
  // compute a diff ~2 days off, contradicting the tool's "valid ISO-8601"
  // contract. A real date round-trips its Y-M-D through Date.UTC unchanged.
  const dateHead = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateHead) {
    const y = Number(dateHead[1]);
    const mo = Number(dateHead[2]);
    const d = Number(dateHead[3]);
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
      return undefined;
    }
  }
  return parsed;
}
