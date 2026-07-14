/**
 * `muse webhook serve` — HTTP entry point for external systems that
 * speak POST. Complements `muse watch-folder` (file-drop entry).
 *
 * Use case: anything that can issue an HTTP request — Zapier,
 * GitHub Actions, IFTTT, a personal shortcut, a desktop hotkey — can
 * notify Muse without writing to a watched directory.
 *
 *   $ muse webhook serve --port 7777
 *
 *   $ curl -X POST localhost:7777/notify \
 *       -H 'content-type: application/json' \
 *       -d '{"title":"Q3 memo","text":"due in 5 min","dueAt":"2026-05-12T15:00Z"}'
 *
 *   $ curl -X POST localhost:7777/notify --data 'just a string body'
 *
 * Both forms fire a proactive notice through the configured
 * messaging provider and (with `--as-task`) also create a tracked
 * task that the proactive daemon will later remind about.
 *
 * Pure http.createServer. No external dependency. Loopback bind by
 * default (127.0.0.1) so it's not exposed beyond the user's machine.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  buildMessagingRegistry,
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { appendProactiveHistory, parseTaskDueAt, readTasks, writeTasks, type PersistedTask } from "@muse/stores";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { waitForShutdownSignal } from "./async-promises.js";
import { readRequestBody } from "./async-promises.js";
import type { ProgramIO } from "./program.js";

interface ServeOptions {
  readonly port: string;
  readonly host?: string;
  readonly provider?: string;
  readonly destination?: string;
  readonly asTask?: boolean;
}

export interface NotifyBody {
  readonly title?: string;
  readonly text?: string;
  readonly body?: string;
  readonly dueAt?: string;
}

/**
 * Resolve a webhook `dueAt` hint. Mirrors watch-folder's
 * `resolveInboxDueAt` philosophy: a present-but-unparseable value is
 * surfaced as `unparsed` rather than silently dropped, so a caller
 * that sends `dueAt: "next freday"` learns the task was created
 * without a due date instead of getting a 202 and a dueless task.
 */
export function resolveWebhookDueAt(
  rawDueAt: string | undefined,
  now: () => Date
): { readonly dueAt?: string; readonly unparsed?: string } {
  if (typeof rawDueAt !== "string" || rawDueAt.trim().length === 0) return {};
  const parsed = parseTaskDueAt(rawDueAt, now);
  return parsed instanceof Error ? { unparsed: rawDueAt } : { dueAt: parsed };
}

export type WebhookNotify =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly title: string;
      readonly text: string;
      readonly notice: string;
      readonly dueAt?: string;
      readonly dueAtUnparsed?: string;
    };

/**
 * Normalise a parsed notify payload into the title / notice / task
 * fields the handler needs. Pure so every shape (JSON vs plain text,
 * empty body, oversized title/text, good vs typo'd dueAt) is testable
 * without spinning up the HTTP server. `ok:false` means an empty body
 * (the handler answers 400).
 */
export function buildWebhookNotify(payload: NotifyBody, now: () => Date): WebhookNotify {
  const title = (payload.title ?? "Webhook").toString().slice(0, 200);
  const text = (payload.text ?? payload.body ?? "").toString().slice(0, 1024);
  if (text.trim().length === 0) return { ok: false };
  const notice = `📥 ${title}: ${text.slice(0, 240)}${text.length > 240 ? "…" : ""}`;
  const due = resolveWebhookDueAt(payload.dueAt, now);
  return {
    notice,
    ok: true,
    text,
    title,
    ...(due.dueAt ? { dueAt: due.dueAt } : {}),
    ...(due.unparsed ? { dueAtUnparsed: due.unparsed } : {})
  };
}

function readBody(req: Parameters<typeof readRequestBody>[0], maxBytes = 64 * 1024): Promise<string> {
  return readRequestBody(req, maxBytes);
}

export function registerWebhookCommand(program: Command, io: ProgramIO): void {
  const webhook = program.command("webhook").description("HTTP entry point for external proactive triggers");
  webhook
    .command("serve")
    .description("Run a loopback HTTP server: POST /notify body → proactive notice (and optional task)")
    .option("--port <n>", "TCP port (default 7777)", "7777")
    .option("--host <ip>", "Bind address (default 127.0.0.1 — local-only)", "127.0.0.1")
    .option("--provider <id>", "Messaging provider (default 'log')")
    .option("--destination <id>", "Messaging destination (default '@me')")
    .option("--as-task", "Also create a tracked task for each notice")
    .action(async (options: ServeOptions) => {
      const port = Math.max(1, Number.parseInt(options.port, 10) || 7777);
      const host = options.host ?? "127.0.0.1";
      const provider = options.provider ?? "log";
      const destination = options.destination ?? "@me";
      const asTask = options.asTask === true;

      const registry = buildMessagingRegistry(process.env);
      if (!registry.has(provider)) {
        const known = registry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean --provider ${suggestion}?` : "";
        io.stderr(`Provider '${provider}' is not registered${hint}. Try --provider log.\n`);
        process.exitCode = 1;
        return;
      }
      const historyFile = resolveProactiveHistoryFile(process.env);
      const tasksFile = asTask ? resolveTasksFile(process.env) : undefined;

      io.stdout(`muse webhook serve — http://${host}:${port.toString()}\n`);
      io.stdout(`  provider=${provider}, destination=${destination}${asTask ? ", as-task ON" : ""}\n`);
      io.stdout(`  POST /notify with JSON {title, text, dueAt} or a plain-text body.\n`);
      io.stdout(`  (Ctrl-C to stop)\n\n`);

      const server = createServer(async (req, res) => {
        try {
          if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ asTask, destination, ok: true, provider }));
            return;
          }
          if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/notify") {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not found. Try POST /notify\n");
            return;
          }

          const rawBody = await readBody(req);
          let payload: NotifyBody;
          const contentType = (req.headers["content-type"] ?? "").toString();
          if (contentType.includes("application/json")) {
            try {
              payload = JSON.parse(rawBody) as NotifyBody;
            } catch {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("Invalid JSON\n");
              return;
            }
          } else {
            payload = { text: rawBody };
          }

          const built = buildWebhookNotify(payload, () => new Date());
          if (!built.ok) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Empty body — provide `text` (or POST plain-text payload).\n");
            return;
          }
          const { title, text, notice, dueAt, dueAtUnparsed } = built;
          await registry.send(provider, { destination, text: notice });

          let taskId: string | undefined;
          if (asTask && tasksFile) {
            if (dueAtUnparsed !== undefined) {
              io.stderr(`  dueAt ${JSON.stringify(dueAtUnparsed)} not understood — task created without a due date\n`);
            }
            const task: PersistedTask = {
              createdAt: new Date().toISOString(),
              ...(dueAt ? { dueAt } : {}),
              id: `webhook_${randomUUID()}`,
              notes: text,
              status: "open",
              tags: ["webhook"],
              title
            };
            const existing = await readTasks(tasksFile);
            await writeTasks(tasksFile, [...existing, task]);
            taskId = task.id;
          }

          await appendProactiveHistory(historyFile, {
            destination,
            firedAtIso: new Date().toISOString(),
            itemId: taskId ?? `webhook:${title}`,
            kind: "task",
            providerId: provider,
            startIso: new Date().toISOString(),
            status: "delivered",
            text: notice,
            title
          });

          io.stdout(`[${new Date().toISOString()}] fired "${title}" → ${provider}/${destination}${taskId ? ` (task ${taskId})` : ""}\n`);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({
            delivered: true,
            taskId: taskId ?? null,
            title,
            ...(asTask && dueAtUnparsed !== undefined ? { dueAtIgnored: dueAtUnparsed } : {})
          }));
        } catch (cause) {
          io.stderr(`handler error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Internal error\n");
        }
      });

      server.listen(port, host);

      await waitForShutdownSignal();
      server.close();
      io.stdout("\n(ctrl-c — stopping)\n");
    });
}
