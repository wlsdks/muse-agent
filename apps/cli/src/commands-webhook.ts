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
import {
  appendProactiveHistory,
  parseTaskDueAt,
  readTasks,
  writeTasks,
  type PersistedTask
} from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface ServeOptions {
  readonly port: string;
  readonly host?: string;
  readonly provider?: string;
  readonly destination?: string;
  readonly asTask?: boolean;
}

interface NotifyBody {
  readonly title?: string;
  readonly text?: string;
  readonly body?: string;
  readonly dueAt?: string;
}

function readBody(req: import("node:http").IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

      const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
      if (!registry.has(provider)) {
        io.stderr(`Provider '${provider}' is not registered. Try --provider log.\n`);
        process.exitCode = 1;
        return;
      }
      const historyFile = resolveProactiveHistoryFile(process.env as Record<string, string | undefined>);
      const tasksFile = asTask ? resolveTasksFile(process.env as Record<string, string | undefined>) : undefined;

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

          const title = (payload.title ?? "Webhook").toString().slice(0, 200);
          const text = (payload.text ?? payload.body ?? "").toString().slice(0, 1024);
          if (text.trim().length === 0) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Empty body — provide `text` (or POST plain-text payload).\n");
            return;
          }

          const notice = `📥 ${title}: ${text.slice(0, 240)}${text.length > 240 ? "…" : ""}`;
          await registry.send(provider, { destination, text: notice });

          let taskId: string | undefined;
          if (asTask && tasksFile) {
            let dueAt: string | undefined;
            if (payload.dueAt) {
              const parsed = parseTaskDueAt(payload.dueAt, () => new Date());
              if (!(parsed instanceof Error)) {
                dueAt = parsed;
              }
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
          res.end(JSON.stringify({ delivered: true, taskId: taskId ?? null, title }));
        } catch (cause) {
          io.stderr(`handler error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Internal error\n");
        }
      });

      server.listen(port, host);

      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        server.close();
        io.stdout("\n(ctrl-c — stopping)\n");
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      await new Promise(() => { /* hold the loop */ });
    });
}
