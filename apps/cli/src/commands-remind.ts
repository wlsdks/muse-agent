/**
 * `muse remind` command group — passive personal reminders.
 *
 *   - `muse remind <when> <text...>`  — add (default action)
 *   - `muse remind list`              — list pending (also: --status fired|all|due)
 *   - `muse remind clear <id>`        — remove
 *
 * Reminders are surfaced in `muse today` once their dueAt has
 * passed. Active firing through messaging is a follow-up iter.
 *
 * `<when>` accepts the same grammar as task `--due`: ISO-8601 or a
 * relative phrase ("tomorrow at 6pm", "in 3 hours", "next Monday").
 *
 * Both subcommands honour `--local` to skip the API and operate on
 * `~/.muse/reminders.json` directly via the shared store.
 */

import { randomUUID } from "node:crypto";

import { buildMessagingRegistry, resolveRemindersFile } from "@muse/autoconfigure";
import {
  filterReminders,
  fireReminder,
  parseReminderDueAt,
  readReminders,
  readReminderStatusFilter,
  runDueReminders,
  serializeReminder,
  writeReminders,
  type PersistedReminder
} from "@muse/mcp";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface RemindCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

function localRemindersFile(): string {
  return resolveRemindersFile(process.env as Record<string, string | undefined>);
}

export function registerRemindCommands(program: Command, io: ProgramIO, helpers: RemindCommandHelpers): void {
  const remind = program.command("remind").description("Personal reminders (passive — surfaced in `muse today`)");

  // Default action: `muse remind <when> <text...>`. Implemented as a
  // subcommand named "add" plus we attach "add" as the default action
  // so `muse remind tomorrow at 9 buy milk` still routes there.
  remind
    .command("add", { isDefault: true })
    .description("Add a reminder. <when> accepts ISO-8601 or relative ('tomorrow at 6pm', 'in 3 hours', 'next Monday')")
    .argument("<when>", "When to remind (ISO-8601 or relative phrase)")
    .argument("<text...>", "Reminder text (joined by spaces)")
    .option("--local", "Write directly to the local reminders file instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .option(
      "--via-provider <id>",
      "Per-reminder routing override — provider id (telegram | discord | slack | line). Both --via flags must be set together."
    )
    .option("--via-destination <id>", "Per-reminder routing override — platform-native chat / channel / user id")
    .action(async (
      when: string,
      textParts: readonly string[],
      options: SharedOptions & { readonly viaProvider?: string; readonly viaDestination?: string },
      command
    ) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("text is required");
      }
      const viaProvider = options.viaProvider?.trim();
      const viaDestination = options.viaDestination?.trim();
      if ((viaProvider && !viaDestination) || (!viaProvider && viaDestination)) {
        throw new Error("--via-provider and --via-destination must be set together (or neither)");
      }
      const via = viaProvider && viaDestination
        ? { destination: viaDestination, providerId: viaProvider }
        : undefined;

      let payload: Record<string, unknown>;
      if (options.local) {
        const dueAt = parseReminderDueAt(when, () => new Date());
        if (dueAt instanceof Error) {
          throw dueAt;
        }
        const created: PersistedReminder = {
          createdAt: new Date().toISOString(),
          dueAt,
          id: `rem_${randomUUID()}`,
          status: "pending",
          text,
          ...(via ? { via } : {})
        };
        const file = localRemindersFile();
        const existing = await readReminders(file);
        await writeReminders(file, [...existing, created]);
        payload = serializeReminder(created);
      } else {
        const body: Record<string, unknown> = { dueAt: when, text };
        if (via) {
          body.via = via;
        }
        payload = (await helpers.apiRequest(io, command, "/api/reminders", body, "POST")) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      const id = String(payload.id ?? "");
      const dueAt = String(payload.dueAt ?? "");
      const viaSuffix = via ? ` → ${via.providerId}:${via.destination}` : "";
      io.stdout(`Added [${id.slice(0, 12)}] ${text} — due ${shortDateTime(dueAt)}${viaSuffix}\n`);
    });

  remind
    .command("list")
    .description("List reminders (default: pending)")
    .option(
      "--status <status>",
      "pending (default), fired, all, or due (overdue/now-or-earlier pending)",
      "pending"
    )
    .option("--local", "Read directly from the local reminders file instead of the API")
    .option("--json", "Print the raw response instead of the formatted list")
    .action(async (options: { readonly status: string } & SharedOptions, command) => {
      let payload: { reminders: ReadonlyArray<Record<string, unknown>>; status: string; total: number };
      if (options.local) {
        const file = localRemindersFile();
        const status = readReminderStatusFilter(options.status);
        const reminders = await readReminders(file);
        const filtered = filterReminders(reminders, status, () => new Date());
        const sorted = [...filtered].sort((left, right) => left.dueAt.localeCompare(right.dueAt));
        payload = {
          reminders: sorted.map(serializeReminder) as ReadonlyArray<Record<string, unknown>>,
          status,
          total: sorted.length
        };
      } else {
        const path = `/api/reminders?status=${encodeURIComponent(options.status)}`;
        payload = (await helpers.apiRequest(io, command, path)) as typeof payload;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatReminderList(payload));
    });

  remind
    .command("snooze")
    .description("Bump a reminder's dueAt forward (default 10 min)")
    .argument("<id>", "Reminder id")
    .option(
      "--in <when>",
      "When to remind instead. Same grammar as `add` (e.g. 'in 30 minutes', 'tomorrow at 9am')"
    )
    .option("--local", "Update the local reminders file instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      id: string,
      options: { readonly in?: string } & SharedOptions,
      command
    ) => {
      let payload: Record<string, unknown>;
      if (options.local) {
        const file = localRemindersFile();
        const reminders = await readReminders(file);
        const index = reminders.findIndex((reminder) => reminder.id === id);
        if (index < 0) {
          throw new Error(`reminder not found: ${id}`);
        }
        let nextDueAt: string;
        if (options.in && options.in.trim().length > 0) {
          const parsed = parseReminderDueAt(options.in, () => new Date());
          if (parsed instanceof Error) {
            throw parsed;
          }
          nextDueAt = parsed;
        } else {
          nextDueAt = new Date(Date.now() + 10 * 60_000).toISOString();
        }
        const snoozed: PersistedReminder = { ...reminders[index]!, dueAt: nextDueAt, status: "pending" };
        const next = [...reminders];
        next[index] = snoozed;
        await writeReminders(file, next);
        payload = serializeReminder(snoozed);
      } else {
        const body: Record<string, unknown> = {};
        if (options.in && options.in.trim().length > 0) {
          body.dueAt = options.in.trim();
        }
        payload = (await helpers.apiRequest(
          io,
          command,
          `/api/reminders/${encodeURIComponent(id)}/snooze`,
          body,
          "POST"
        )) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      const dueAt = String(payload.dueAt ?? "");
      io.stdout(`Snoozed [${id.slice(0, 12)}] → ${shortDateTime(dueAt)}\n`);
    });

  remind
    .command("fire")
    .description("Mark a reminder as delivered — flips status pending → fired, stops surfacing in `today`")
    .argument("<id>", "Reminder id")
    .option(
      "--at <iso>",
      "Optional ISO-8601 firedAt (defaults to now). Useful for backfilling delayed log entries."
    )
    .option("--local", "Update the local reminders file instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      id: string,
      options: { readonly at?: string } & SharedOptions,
      command
    ) => {
      let payload: Record<string, unknown>;
      let firedAt: string;
      if (options.at && options.at.trim().length > 0) {
        const parsed = new Date(options.at);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(`--at must be a parseable ISO-8601 timestamp (got ${JSON.stringify(options.at)})`);
        }
        firedAt = parsed.toISOString();
      } else {
        firedAt = new Date().toISOString();
      }
      if (options.local) {
        const file = localRemindersFile();
        const reminders = await readReminders(file);
        const next = fireReminder(reminders, id, firedAt);
        if (!next) {
          throw new Error(`reminder not found: ${id}`);
        }
        await writeReminders(file, next);
        const fired = next.find((reminder) => reminder.id === id) as PersistedReminder;
        payload = serializeReminder(fired);
      } else {
        const body: Record<string, unknown> = {};
        if (options.at && options.at.trim().length > 0) {
          body.firedAt = options.at.trim();
        }
        payload = (await helpers.apiRequest(
          io,
          command,
          `/api/reminders/${encodeURIComponent(id)}/fire`,
          body,
          "POST"
        )) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      const firedAtOut = String(payload.firedAt ?? firedAt);
      io.stdout(`Fired [${id.slice(0, 12)}] at ${shortDateTime(firedAtOut)}\n`);
    });

  remind
    .command("run")
    .description("Phase B firing loop: deliver every due reminder via messaging then mark fired")
    .option(
      "--via <provider>",
      "Messaging provider id (telegram | discord | slack | line). Required unless --dry-run."
    )
    .option(
      "--destination <id>",
      "Platform-native chat / channel / user id. Required unless --dry-run."
    )
    .option("--dry-run", "Preview which reminders would fire without sending or persisting")
    .option("--local", "Read/write the local reminders file directly (always implicit; no --no-local mode yet)")
    .option("--json", "Print the raw run summary as JSON")
    .action(async (
      options: {
        readonly via?: string;
        readonly destination?: string;
        readonly dryRun?: boolean;
        readonly json?: boolean;
        readonly local?: boolean;
      }
    ) => {
      const file = localRemindersFile();

      if (options.dryRun) {
        const all = await readReminders(file);
        const due = filterReminders(all, "due", () => new Date());
        const summary = {
          delivered: 0,
          due: due.length,
          errors: [] as string[],
          previews: due.map((reminder) => ({ id: reminder.id, text: reminder.text }))
        };
        if (options.json) {
          helpers.writeOutput(io, summary);
          return;
        }
        if (due.length === 0) {
          io.stdout("No reminders are due right now.\n");
          return;
        }
        io.stdout(`Would fire ${due.length.toString()} reminder(s):\n`);
        for (const reminder of due) {
          io.stdout(`  - [${reminder.id.slice(0, 12)}] ${reminder.text}\n`);
        }
        return;
      }

      const provider = options.via?.trim();
      const destination = options.destination?.trim();
      if (!provider || !destination) {
        throw new Error("--via and --destination are required (or use --dry-run for a preview)");
      }

      const registry: MessagingProviderRegistry = buildMessagingRegistry(
        process.env as Record<string, string | undefined>
      );
      const summary = await runDueReminders({
        destination,
        file,
        providerId: provider,
        registry
      });

      if (options.json) {
        helpers.writeOutput(io, {
          delivered: summary.delivered,
          due: summary.due,
          errors: summary.errors
        });
        return;
      }
      if (summary.due === 0) {
        io.stdout("No reminders are due right now.\n");
        return;
      }
      io.stdout(`Fired ${summary.delivered.toString()} of ${summary.due.toString()} reminder(s) via ${provider}\n`);
      for (const error of summary.errors) {
        io.stderr(`  ! ${error}\n`);
      }
    });

  remind
    .command("clear")
    .description("Remove a reminder")
    .argument("<id>", "Reminder id")
    .option("--local", "Delete from the local reminders file instead of the API")
    .action(async (id: string, options: { readonly local?: boolean }, command) => {
      if (options.local) {
        const file = localRemindersFile();
        const reminders = await readReminders(file);
        const next = reminders.filter((reminder) => reminder.id !== id);
        if (next.length === reminders.length) {
          throw new Error(`reminder not found: ${id}`);
        }
        await writeReminders(file, next);
        io.stdout(`Cleared reminder ${id}\n`);
        return;
      }
      await helpers.apiRequest(io, command, `/api/reminders/${encodeURIComponent(id)}`, undefined, "DELETE");
      io.stdout(`Cleared reminder ${id}\n`);
    });
}

function formatReminderList(payload: { reminders: ReadonlyArray<Record<string, unknown>>; status: string; total: number }): string {
  if (payload.reminders.length === 0) {
    return `Reminders (${payload.status}): (none)\n`;
  }
  const lines = payload.reminders.map((reminder) => {
    const id = String(reminder.id ?? "");
    const dueAt = String(reminder.dueAt ?? "");
    const text = String(reminder.text ?? "");
    const fired = reminder.status === "fired" ? " (fired)" : "";
    return `  - [${id.slice(0, 12)}] ${shortDateTime(dueAt)}  ${text}${fired}`;
  });
  return `Reminders (${payload.reminders.length} ${payload.status}):\n${lines.join("\n")}\n`;
}

function shortDateTime(iso: string): string {
  if (iso.length < 16) {
    return iso;
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
