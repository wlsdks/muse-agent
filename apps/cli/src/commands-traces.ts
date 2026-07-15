/**
 * `muse traces` command group. Wraps `/api/admin/traces` (list of
 * trace events) and `/api/admin/traces/:traceId/spans` (per-trace
 * span filter) so trace inspection is reachable from the terminal.
 */

import { isRecord, sleep } from "@muse/shared";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface TracesCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerTracesCommands(program: Command, io: ProgramIO, helpers: TracesCommandHelpers): void {
  const traces = program.command("traces").description("Inspect recorded trace events / spans");

  traces
    .command("list")
    .description("All recorded trace events (or recorded spans when the trace sink is empty)")
    .action(async (_options, command: Command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/admin/traces"));
    });

  traces
    .command("spans")
    .description("Spans associated with a specific trace id or run id")
    .argument("<trace-id>", "Trace id (or run id) to filter on")
    .action(async (traceId: string, _options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/traces/${encodeURIComponent(traceId)}/spans`)
      );
    });

  // Polls (the in-memory trace sink has no SSE) and prints new
  // events per tick. wireReplGracefulExit so Ctrl-C doesn't
  // strand the polling timer.
  traces
    .command("tail")
    .description("Poll /api/admin/traces and print new trace events as they arrive")
    .option("--interval <seconds>", "Poll interval in seconds (default 2, clamped to [1, 60])")
    .option("--limit <n>", "Max events surfaced per tick (default 20)")
    .action(async (
      options: { readonly interval?: string; readonly limit?: string },
      command: Command
    ) => {
      const intervalMs = resolveTraceTailIntervalMs(options.interval);
      const limit = resolveTraceTailLimit(options.limit);
      const { wireReplGracefulExit } = await import("./chat-repl.js");
      let stopped = false;
      const teardown = wireReplGracefulExit({
        onSignal: () => { stopped = true; io.stderr("\n(stopping trace tail…)\n"); }
      });
      // Track the most-recent (id, ts) we've already printed so a
      // poll-tick doesn't re-print the same event. Events keyed by
      // a stringified shape so any field order works.
      const seen = new Set<string>();
      try {
        while (!stopped) {
          const response = await helpers.apiRequest(io, command, `/api/admin/traces?limit=${limit.toString()}`);
          const events = extractTraceTailEvents(response);
          for (const event of events) {
            const key = traceEventKey(event);
            if (seen.has(key)) continue;
            seen.add(key);
            io.stdout(`${JSON.stringify(event)}\n`);
          }
          if (stopped) break;
          await sleep(intervalMs);
        }
      } finally {
        teardown();
      }
    });
}

/**
 * Parse `--interval <seconds>` into milliseconds.
 * Default 2s, clamped to [1, 60]. Exported for direct test
 * coverage of the boundary behavior.
 */
export function resolveTraceTailIntervalMs(raw: string | undefined): number {
  if (!raw) return 2_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2_000;
  const seconds = Math.min(60, Math.max(1, parsed));
  return Math.round(seconds * 1_000);
}

/**
 * Parse `--limit <n>` for the per-tick fetch.
 * Default 20, clamped to [1, 200]. Exported for tests.
 */
export function resolveTraceTailLimit(raw: string | undefined): number {
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(200, Math.max(1, parsed));
}

/**
 * Coerce the `/api/admin/traces` payload into an
 * array of trace events regardless of whether the server wraps
 * them under `{ events: [...] }` or returns the array directly.
 * Exported for test coverage.
 */
export function extractTraceTailEvents(payload: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  }
  if (payload && typeof payload === "object") {
    const payloadRecord = isRecord(payload) ? payload : undefined;
    const candidate = payloadRecord?.events ?? payloadRecord?.spans;
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
    }
  }
  return [];
}

function traceEventKey(event: Record<string, unknown>): string {
  // Composite key — prefer (id || spanId || traceId) + (ts || timestamp).
  // Falls back to JSON when nothing identifying is present so
  // duplicates still dedupe on byte-for-byte equality.
  const id = event["id"] ?? event["spanId"] ?? event["traceId"];
  const ts = event["ts"] ?? event["timestamp"] ?? event["startTime"];
  if (typeof id === "string" && (typeof ts === "string" || typeof ts === "number")) {
    return `${id}|${String(ts)}`;
  }
  return JSON.stringify(event);
}
