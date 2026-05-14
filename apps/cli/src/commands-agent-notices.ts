/**
 * `muse agent-notices tail` — subscribe to `/api/agent-notices/stream`
 * and print each Phase D proactive notice as it fires.
 *
 * Wire-up: Phase D producer (proactive notice loop) → broker →
 * `/api/agent-notices/stream` SSE endpoint → this command's
 * EventSource-style consumer → stdout. Closes the loop the design
 * doc sketched: the user can park a terminal on this command and
 * see every agent-initiated heads-up alongside their existing
 * messaging-sink delivery.
 *
 * Connection lifecycle: opens once, prints `event: open` ack on
 * connect, then renders `event: notice` payloads. Cleanly aborts
 * on SIGINT / Ctrl-C.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";
import { formatApiErrorResponse, readApiOptions, readSseEvents } from "./program-helpers.js";

export interface AgentNoticesCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  ) => Promise<unknown>;
}

interface TailOptions {
  readonly user?: string;
  readonly json?: boolean;
}

function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function resolveUserId(explicit: string | undefined): string {
  return explicit ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
}

export function registerAgentNoticesCommands(
  program: Command,
  io: ProgramIO,
  _helpers: AgentNoticesCommandHelpers
): void {
  const group = program
    .command("agent-notices")
    .description("Phase D agent-initiated heads-ups streamed by the API");

  group
    .command("tail")
    .description("Stream agent-initiated notices for this user until Ctrl-C")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--json", "Print each notice as a JSON line instead of human format")
    .action(async (options: TailOptions, command: Command) => {
      const userId = resolveUserId(options.user);
      const { baseUrl, token } = await readApiOptions(io, command);
      const url = new URL(`/api/agent-notices/stream?userId=${encodeURIComponent(userId)}`, baseUrl);

      const controller = new AbortController();
      const onSigint = (): void => {
        controller.abort();
      };
      process.once("SIGINT", onSigint);

      try {
        const response = await (io.fetch ?? globalThis.fetch)(url.toString(), {
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          signal: controller.signal
        });
        if (!response.ok) {
          const text = await response.text();
          throw formatApiErrorResponse(response, text, baseUrl);
        }
        for await (const event of readSseEvents(response)) {
          if (event.event === "open") {
            if (!options.json) {
              io.stdout(`(listening for agent-notices on user '${userId}' — Ctrl-C to stop)\n`);
            }
            continue;
          }
          if (event.event === "notice") {
            if (options.json) {
              io.stdout(`${event.data}\n`);
              continue;
            }
            try {
              const parsed = JSON.parse(event.data) as {
                readonly kind?: string;
                readonly text?: string;
                readonly generatedAt?: string;
                readonly sourceId?: string;
              };
              const stamp = parsed.generatedAt ? parsed.generatedAt.slice(11, 16) : "??:??";
              const kind = parsed.kind ?? "agent";
              io.stdout(`[${stamp}] [${kind}] ${parsed.text ?? "(empty)"}\n`);
            } catch {
              io.stdout(`${event.data}\n`);
            }
            continue;
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) {
          if (!options.json) {
            io.stdout("(stopped)\n");
          }
          return;
        }
        throw cause;
      } finally {
        process.off("SIGINT", onSigint);
      }
    });
}
