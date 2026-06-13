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

import { buildMessagingRegistry, resolveReminderHistoryFile, resolveRemindersFile } from "@muse/autoconfigure";
import {
  compareRemindersByDueAt,
  filterReminders,
  fireReminder,
  parseReminderDueAt,
  readReminderHistory,
  readReminders,
  readReminderStatusFilter,
  resolveReminderRef,
  runDueReminders,
  serializeReminder,
  writeReminders,
  type PersistedReminder,
  type ReminderHistoryEntry,
  type ReminderRecurrence
} from "@muse/mcp";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import { isApiUnreachable, withApiLocalFallback } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

/**
 * CLI-side strict validation for `muse remind list --status
 * <value>`. The shared `readReminderStatusFilter` is deliberately
 * lenient (LLM tool path), but the CLI surface should surface
 * typos with the closest-match hint.
 */
const REMIND_STATUS_VALUES = ["pending", "fired", "all", "due"] as const;

function assertReminderStatusInput(raw: string): void {
  const trimmed = raw.trim().toLowerCase();
  if (REMIND_STATUS_VALUES.includes(trimmed as (typeof REMIND_STATUS_VALUES)[number])) {
    return;
  }
  const suggestion = closestCommandName(trimmed, REMIND_STATUS_VALUES);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`--status must be one of: ${REMIND_STATUS_VALUES.join(", ")} (got '${raw}')${hint}`);
}

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

const remindLocalFallback = <T>(
  io: ProgramIO,
  useLocal: boolean,
  local: () => Promise<T>,
  api: () => Promise<T>
): Promise<T> => withApiLocalFallback(io, useLocal, local, api, "reminders");

// Sibling of `filterTasksBySearch` (commands-tasks.ts): narrow a reminder list
// by a free-text substring of its `text`, case-insensitive. A blank query
// returns everything (the flag is a no-op when empty).
export function filterRemindersBySearch<T extends { readonly text?: unknown }>(
  reminders: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...reminders];
  }
  return reminders.filter((r) => (typeof r.text === "string" ? r.text.toLowerCase() : "").includes(q));
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
    .option("--repeat <cadence>", "Repeat the reminder: 'daily', 'weekly', 'monthly', or 'yearly' (re-arms each time it fires; a monthly 31st / yearly Feb 29 lands on the last valid day of shorter months/years). Omit for one-time.")
    .option(
      "--via-provider <id>",
      "Per-reminder routing override — provider id (telegram | discord | slack | line). Both --via flags must be set together."
    )
    .option("--via-destination <id>", "Per-reminder routing override — platform-native chat / channel / user id")
    .action(async (
      when: string,
      textParts: readonly string[],
      options: SharedOptions & { readonly repeat?: string; readonly viaProvider?: string; readonly viaDestination?: string },
      command
    ) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("text is required");
      }
      const repeat = options.repeat?.trim();
      if (repeat !== undefined && repeat !== "daily" && repeat !== "weekly" && repeat !== "monthly" && repeat !== "yearly") {
        throw new Error("--repeat must be 'daily', 'weekly', 'monthly', or 'yearly'");
      }
      const recurrence = repeat as ReminderRecurrence | undefined;
      const viaProvider = options.viaProvider?.trim();
      const viaDestination = options.viaDestination?.trim();
      if ((viaProvider && !viaDestination) || (!viaProvider && viaDestination)) {
        throw new Error("--via-provider and --via-destination must be set together (or neither)");
      }
      const via = viaProvider && viaDestination
        ? { destination: viaDestination, providerId: viaProvider }
        : undefined;

      // Validate before dispatch in BOTH modes: `parseReminderDueAt`
      // is the same grammar the REST route uses, so a bad `<when>`
      // gets the identical actionable error (with examples) whether
      // or not `--local` is set — no degraded API error, no wasted
      // round-trip on input the server would only reject anyway.
      const resolvedDueAt = parseReminderDueAt(when, () => new Date());
      if (resolvedDueAt instanceof Error) {
        throw resolvedDueAt;
      }
      // A reminder fires AT its dueAt, so a PAST time is almost always a date
      // typo (a wrong year, or "at 8am" when it is already 9am) — it would be
      // immediately overdue and fire on the next run, not when the user meant.
      // Warn but don't block (they may have meant it; they can `clear` it).
      if (!options.json && new Date(resolvedDueAt).getTime() < Date.now()) {
        io.stderr(
          `muse: heads up — ${shortDateTime(resolvedDueAt)} is in the PAST; this reminder is already overdue and will fire on the next \`muse remind run\`. `
          + "If that's a typo, `muse remind clear <id>` and re-add a future time.\n"
        );
      }

      const addLocal = async (): Promise<Record<string, unknown>> => {
        const created: PersistedReminder = {
          createdAt: new Date().toISOString(),
          dueAt: resolvedDueAt,
          id: `rem_${randomUUID()}`,
          status: "pending",
          text,
          ...(recurrence ? { recurrence } : {}),
          ...(via ? { via } : {})
        };
        const file = localRemindersFile();
        const existing = await readReminders(file);
        await writeReminders(file, [...existing, created]);
        return serializeReminder(created);
      };
      const addApi = async (): Promise<Record<string, unknown>> => {
        const body: Record<string, unknown> = { dueAt: when, text };
        if (recurrence) {
          body.recurrence = recurrence;
        }
        if (via) {
          body.via = via;
        }
        return (await helpers.apiRequest(io, command, "/api/reminders", body, "POST")) as Record<string, unknown>;
      };
      const payload = await remindLocalFallback(io, Boolean(options.local), addLocal, addApi);
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      const id = String(payload.id ?? "");
      const dueAt = String(payload.dueAt ?? "");
      const viaSuffix = via ? ` → ${via.providerId}:${via.destination}` : "";
      const repeatSuffix = recurrence ? ` (repeats ${recurrence})` : "";
      io.stdout(`Added [${id.slice(0, 12)}] ${text} — due ${shortDateTime(dueAt)}${repeatSuffix}${viaSuffix}\n`);
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
    .option("--search <text>", "Only reminders whose text contains this text (case-insensitive)")
    .action(async (options: { readonly status: string; readonly search?: string } & SharedOptions, command) => {
      // Throws before dispatch so a typo'd --status doesn't return
      // a silently-wrong "pending" list.
      assertReminderStatusInput(options.status);
      type ReminderListPayload = { reminders: ReadonlyArray<Record<string, unknown>>; status: string; total: number };
      const readLocalReminders = async (): Promise<ReminderListPayload> => {
        const file = localRemindersFile();
        const status = readReminderStatusFilter(options.status);
        const reminders = await readReminders(file);
        const filtered = filterReminders(reminders, status, () => new Date());
        const sorted = [...filtered].sort(compareRemindersByDueAt);
        return {
          reminders: sorted.map(serializeReminder) as ReadonlyArray<Record<string, unknown>>,
          status,
          total: sorted.length
        };
      };
      let payload: ReminderListPayload;
      if (options.local) {
        payload = await readLocalReminders();
      } else {
        const path = `/api/reminders?status=${encodeURIComponent(options.status)}`;
        try {
          payload = (await helpers.apiRequest(io, command, path)) as ReminderListPayload;
        } catch (cause) {
          if (!isApiUnreachable(cause)) {
            throw cause;
          }
          io.stderr("muse: API not reachable — reading reminders from the local store.\n");
          payload = await readLocalReminders();
        }
      }
      const query = options.search?.trim();
      if (query) {
        const matched = filterRemindersBySearch(payload.reminders, query);
        payload = { ...payload, reminders: matched, total: matched.length };
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
    .argument("<id>", "Reminder id, id prefix, or text — e.g. 'rent'")
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
      const snoozeLocal = async (): Promise<Record<string, unknown>> => {
        const file = localRemindersFile();
        const reminders = await readReminders(file);
        const resolved = resolveLocalReminderId(id, reminders);
        const index = reminders.findIndex((reminder) => reminder.id === resolved);
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
        return serializeReminder(snoozed);
      };
      const snoozeApi = async (): Promise<Record<string, unknown>> => {
        const body: Record<string, unknown> = {};
        if (options.in && options.in.trim().length > 0) {
          body.dueAt = options.in.trim();
        }
        return (await helpers.apiRequest(
          io,
          command,
          `/api/reminders/${encodeURIComponent(id)}/snooze`,
          body,
          "POST"
        )) as Record<string, unknown>;
      };
      const payload = await remindLocalFallback(io, Boolean(options.local), snoozeLocal, snoozeApi);
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
    .argument("<id>", "Reminder id, id prefix, or text — e.g. 'rent'")
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
      const fireLocal = async (): Promise<Record<string, unknown>> => {
        const file = localRemindersFile();
        const reminders = await readReminders(file);
        const resolved = resolveLocalReminderId(id, reminders);
        const next = fireReminder(reminders, resolved, firedAt);
        if (!next) {
          throw new Error(`reminder not found: ${resolved}`);
        }
        await writeReminders(file, next);
        const fired = next.find((reminder) => reminder.id === resolved) as PersistedReminder;
        return serializeReminder(fired);
      };
      const fireApi = async (): Promise<Record<string, unknown>> => {
        const body: Record<string, unknown> = {};
        if (options.at && options.at.trim().length > 0) {
          body.firedAt = options.at.trim();
        }
        return (await helpers.apiRequest(
          io,
          command,
          `/api/reminders/${encodeURIComponent(id)}/fire`,
          body,
          "POST"
        )) as Record<string, unknown>;
      };
      const payload = await remindLocalFallback(io, Boolean(options.local), fireLocal, fireApi);
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
    .option(
      "--watch",
      "Stay running and re-fire on a cadence (Ctrl-C stops). Mirrors the API server's reminder-tick daemon for users without the server."
    )
    .option(
      "--watch-interval <ms>",
      "Tick cadence for --watch in milliseconds (default 60000, clamped to [5000, 3600000])"
    )
    .action(async (
      options: {
        readonly via?: string;
        readonly destination?: string;
        readonly dryRun?: boolean;
        readonly json?: boolean;
        readonly local?: boolean;
        readonly watch?: boolean;
        readonly watchInterval?: string;
      }
    ) => {
      if (options.watch && options.dryRun) {
        throw new Error("--watch and --dry-run are mutually exclusive (watch needs real delivery to advance reminders)");
      }
      if (options.watch) {
        const provider = options.via?.trim();
        const destination = options.destination?.trim();
        if (!provider || !destination) {
          throw new Error("--watch requires --via and --destination");
        }
        const intervalMs = clampWatchInterval(options.watchInterval);
        const registry: MessagingProviderRegistry = buildMessagingRegistry(
          process.env as Record<string, string | undefined>
        );
        const file = localRemindersFile();
        let firing = false;
        const tick = async (): Promise<void> => {
          if (firing) {
            return;
          }
          firing = true;
          try {
            const summary = await runDueReminders({ destination, file, providerId: provider, registry });
            if (summary.due > 0) {
              io.stdout(
                `[${new Date().toISOString()}] fired ${summary.delivered.toString()} of ${summary.due.toString()} reminder(s) via ${provider}\n`
              );
              for (const error of summary.errors) {
                io.stderr(`  ! ${error}\n`);
              }
            }
          } finally {
            firing = false;
          }
        };
        io.stdout(`muse remind run --watch: tick every ${intervalMs.toString()}ms via ${provider}. Ctrl-C to stop.\n`);
        const handle = setInterval(() => { void tick(); }, intervalMs);
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            clearInterval(handle);
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            io.stdout("muse remind run --watch: stopping.\n");
            resolve();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return;
      }

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
    .command("history")
    .description("Audit recent reminder firings (newest first). Each entry: status, provider→destination, time, error (if any)")
    .option("--limit <n>", "Max entries to return (default 20, cap 500)", "20")
    .option("--local", "Read directly from the local history file instead of the API")
    .option("--json", "Print the raw response instead of the formatted list")
    .action(async (options: { readonly limit: string; readonly local?: boolean; readonly json?: boolean }, command) => {
      const limit = parseLimitOrDefault(options.limit);
      type HistoryPayload = { entries: readonly ReminderHistoryEntry[]; total: number };
      const historyLocal = async (): Promise<HistoryPayload> => {
        const file = resolveReminderHistoryFile(process.env as Record<string, string | undefined>);
        const entries = await readReminderHistory(file, limit);
        return { entries, total: entries.length };
      };
      const historyApi = async (): Promise<HistoryPayload> =>
        (await helpers.apiRequest(io, command, `/api/reminders/history?limit=${limit.toString()}`)) as HistoryPayload;
      const payload = await remindLocalFallback(io, Boolean(options.local), historyLocal, historyApi);
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatReminderHistory(payload));
    });

  remind
    .command("clear")
    .description("Remove a reminder")
    .argument("<id>", "Reminder id, id prefix, or text — e.g. 'rent'")
    .option("--local", "Delete from the local reminders file instead of the API")
    .action(async (id: string, options: { readonly local?: boolean }, command) => {
      const clearLocal = async (): Promise<string> => {
        const file = localRemindersFile();
        const reminders = await readReminders(file);
        const resolved = resolveLocalReminderId(id, reminders);
        const next = reminders.filter((reminder) => reminder.id !== resolved);
        await writeReminders(file, next);
        return resolved;
      };
      const clearApi = async (): Promise<string> => {
        await helpers.apiRequest(io, command, `/api/reminders/${encodeURIComponent(id)}`, undefined, "DELETE");
        return id;
      };
      const cleared = await remindLocalFallback(io, Boolean(options.local), clearLocal, clearApi);
      io.stdout(`Cleared reminder ${cleared}\n`);
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
    const repeats = typeof reminder.recurrence === "string" ? ` (repeats ${reminder.recurrence})` : "";
    const fired = reminder.status === "fired" ? " (fired)" : "";
    return `  - [${id.slice(0, 12)}] ${shortDateTime(dueAt)}  ${text}${repeats}${fired}`;
  });
  return `Reminders (${payload.reminders.length} ${payload.status}):\n${lines.join("\n")}\n`;
}


function parseLimitOrDefault(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(500, parsed);
}

const WATCH_INTERVAL_DEFAULT_MS = 60_000;
const WATCH_INTERVAL_MIN_MS = 5_000;
const WATCH_INTERVAL_MAX_MS = 60 * 60_000;

function clampWatchInterval(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return WATCH_INTERVAL_DEFAULT_MS;
  }
  return Math.max(WATCH_INTERVAL_MIN_MS, Math.min(WATCH_INTERVAL_MAX_MS, parsed));
}

function formatReminderHistory(payload: {
  entries: readonly ReminderHistoryEntry[];
  total: number;
}): string {
  if (payload.entries.length === 0) {
    return "Reminder history: (none)\n";
  }
  const lines = payload.entries.map((entry) => {
    const mark = entry.status === "delivered" ? "✓" : "✗";
    const when = shortDateTime(entry.firedAtIso);
    const route = `${entry.providerId}→${entry.destination}`;
    const trail = entry.error ? `  ! ${entry.error}` : "";
    return `  ${mark} ${when}  ${route}  ${entry.text}${trail}`;
  });
  return `Reminder history (${payload.entries.length.toString()} of ${payload.total.toString()}):\n${lines.join("\n")}\n`;
}

/**
 * Resolve a reminder id the user typed against the local store.
 * Accepts the full uuid or the 12-char prefix the list/add
 * renderers print (`rem_0810976`). Refuses to guess when the
 * prefix matches more than one row.
 */
/**
 * Resolve a CLI reminder reference to a single id. An exact id wins; then a
 * unique id PREFIX; then — the capability this adds — the reminder TEXT, so
 * `muse remind clear "pay rent"` / `snooze "standup"` work like the agent's
 * by-name reminder tools instead of demanding the raw uuid (reuses the SAME
 * `resolveReminderRef`: case-insensitive text substring, PENDING preferred).
 * Ambiguity NEVER guesses — it throws with the candidate texts.
 */
export function resolveLocalReminderId(input: string, all: readonly PersistedReminder[]): string {
  const exact = all.find((reminder) => reminder.id === input);
  if (exact) return exact.id;
  const matches = all.filter((reminder) => reminder.id.startsWith(input));
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous reminder prefix '${input}' matched ${matches.length.toString()} reminders; use a longer id`);
  }
  const byText = resolveReminderRef(all, input);
  if (byText.status === "resolved") {
    return byText.reminder.id;
  }
  if (byText.status === "ambiguous") {
    const texts = byText.candidates.map((reminder) => `'${reminder.text}'`).join(", ");
    throw new Error(`'${input}' matches ${byText.candidates.length.toString()} reminders: ${texts} — be more specific or use the id`);
  }
  const suggestion = closestCommandName(input.trim(), all.map((r) => r.id));
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`reminder not found: ${input}${hint}`);
}
