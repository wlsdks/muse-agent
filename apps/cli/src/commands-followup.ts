/**
 * `muse followup` command group — visibility + control over the
 * agent's self-queued follow-up promises.
 *
 *   - `muse followup list`              — pending (default; also: --status fired|cancelled|all)
 *   - `muse followup show <id>`         — full record
 *   - `muse followup cancel <id>`       — flip status → cancelled
 *
 * Followups are captured automatically by the runtime hook when an
 * assistant turn says something like "I'll check in 30 minutes"
 * (see `packages/agent-core/src/followup-capture-hook.ts`) and
 * fired by `apps/api/src/followup-tick.ts` once their `scheduledFor`
 * has passed. This CLI is the user's window into that queue.
 *
 * Local-only by design — no REST surface yet. The store is a
 * single-user `~/.muse/followups.json`; the daemon's own writes
 * are tmp+rename atomic so concurrent reads here are safe.
 */

import { resolveFollowupsFile } from "@muse/autoconfigure";
import {
  cancelFollowup,
  compareFollowupsByScheduledFor,
  parseReminderDueAt,
  readFollowups,
  readFollowupStatusFilter,
  serializeFollowup,
  snoozeFollowup,
  type FollowupStatusFilter,
  type PersistedFollowup
} from "@muse/mcp";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

const FOLLOWUP_STATUS_VALUES = ["scheduled", "fired", "cancelled", "all"] as const;

interface SharedOptions {
  readonly json?: boolean;
}

function localFollowupsFile(): string {
  return resolveFollowupsFile(process.env as Record<string, string | undefined>);
}

export function registerFollowupCommands(program: Command, io: ProgramIO): void {
  const followup = program
    .command("followup")
    .description("Self-queued follow-up promises (auto-captured from agent turns)");

  followup
    .command("list")
    .description("List followups (default: scheduled)")
    .option(
      "--status <status>",
      "scheduled (default), fired, cancelled, or all",
      "scheduled"
    )
    .option("--json", "Print the raw payload instead of the formatted list")
    .option("--search <text>", "Only followups whose summary contains this text (case-insensitive)")
    .action(async (options: { readonly status: string; readonly search?: string } & SharedOptions) => {
      // Validate like `tasks`/`checkins` list — readFollowupStatusFilter is
      // lenient (any typo silently → "scheduled"), so a typo'd --status would
      // otherwise show the WRONG set with no signal.
      const raw = options.status.trim().toLowerCase();
      if (!(FOLLOWUP_STATUS_VALUES as readonly string[]).includes(raw)) {
        const suggestion = closestCommandName(raw, FOLLOWUP_STATUS_VALUES);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(`muse followup list: --status must be one of: ${FOLLOWUP_STATUS_VALUES.join(", ")} (got '${options.status}')${hint}\n`);
        process.exitCode = 1;
        return;
      }
      const status = readFollowupStatusFilter(raw);
      const file = localFollowupsFile();
      const all = await readFollowups(file);
      const filtered = filterByStatus(all, status);
      const sorted = [...filtered].sort(compareFollowupsByScheduledFor);
      const query = options.search?.trim().toLowerCase();
      const matched = query ? sorted.filter((f) => f.summary.toLowerCase().includes(query)) : sorted;
      const payload = {
        followups: matched.map(serializeFollowup),
        status,
        total: matched.length
      };
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      io.stdout(formatFollowupList(payload, matched));
    });

  followup
    .command("show")
    .description("Show a single followup by id (prefix-match allowed)")
    .argument("<id>", "Followup id or unambiguous prefix")
    .option("--json", "Print the full record as JSON")
    .action(async (id: string, options: SharedOptions) => {
      const all = await readFollowups(localFollowupsFile());
      const resolved = resolveFollowupId(id, all);
      const record = all.find((entry) => entry.id === resolved);
      if (!record) {
        throw new Error(`No followup found with id "${id}"`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(serializeFollowup(record), null, 2)}\n`);
        return;
      }
      io.stdout(formatFollowupDetail(record));
    });

  followup
    .command("snooze")
    .description("Push a scheduled followup's scheduledFor forward. <when> accepts ISO-8601 or relative ('in 30 min', 'tomorrow at 9am', '2시간 뒤')")
    .argument("<id>", "Followup id or unambiguous prefix")
    .argument("<when...>", "New target time")
    .option("--json", "Print the patched record as JSON")
    .action(async (id: string, whenParts: readonly string[], options: SharedOptions) => {
      const whenRaw = whenParts.join(" ").trim();
      if (whenRaw.length === 0) {
        throw new Error("<when> is required");
      }
      const parsed = parseReminderDueAt(whenRaw, () => new Date());
      if (parsed instanceof Error) {
        throw parsed;
      }
      const file = localFollowupsFile();
      const all = await readFollowups(file);
      const resolved = resolveFollowupId(id, all);
      const patched = await snoozeFollowup(file, resolved, parsed);
      if (!patched) {
        const existing = all.find((entry) => entry.id === resolved);
        if (!existing) {
          throw new Error(`No followup found with id "${id}"`);
        }
        throw new Error(`Followup ${resolved.slice(0, 12)} is already ${existing.status}; only scheduled followups can be snoozed`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(serializeFollowup(patched), null, 2)}\n`);
        return;
      }
      io.stdout(`Snoozed [${patched.id.slice(0, 12)}] ${patched.summary} → ${shortDateTime(patched.scheduledFor)}\n`);
    });

  followup
    .command("cancel")
    .description("Cancel a scheduled followup (no-op when already fired or cancelled)")
    .argument("<id>", "Followup id or unambiguous prefix")
    .option("--reason <reason>", "Short reason recorded on the entry", "user-cancelled")
    .option("--json", "Print the patched record as JSON")
    .action(async (id: string, options: { readonly reason: string } & SharedOptions) => {
      const file = localFollowupsFile();
      const all = await readFollowups(file);
      const resolved = resolveFollowupId(id, all);
      const patched = await cancelFollowup(file, resolved, options.reason);
      if (!patched) {
        // Either missing or non-scheduled — make the failure mode explicit so
        // the user knows why nothing happened.
        const existing = all.find((entry) => entry.id === resolved);
        if (!existing) {
          throw new Error(`No followup found with id "${id}"`);
        }
        throw new Error(`Followup ${resolved.slice(0, 12)} is already ${existing.status}; nothing to cancel`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(serializeFollowup(patched), null, 2)}\n`);
        return;
      }
      io.stdout(`Cancelled [${patched.id.slice(0, 12)}] ${patched.summary} (reason: ${options.reason})\n`);
    });
}

function filterByStatus(
  all: readonly PersistedFollowup[],
  status: FollowupStatusFilter
): readonly PersistedFollowup[] {
  if (status === "all") {
    return all;
  }
  return all.filter((entry) => entry.status === status);
}

function resolveFollowupId(input: string, all: readonly PersistedFollowup[]): string {
  // Exact match wins.
  if (all.some((entry) => entry.id === input)) {
    return input;
  }
  // Otherwise prefix-match. Reject when the prefix is ambiguous so the user
  // gets feedback instead of silently acting on the wrong one.
  const matches = all.filter((entry) => entry.id.startsWith(input));
  if (matches.length === 0) {
    throw new Error(`No followup found with id "${input}"`);
  }
  if (matches.length > 1) {
    const previews = matches.slice(0, 5).map((entry) => entry.id.slice(0, 16)).join(", ");
    throw new Error(`Ambiguous followup id "${input}" — matches ${matches.length.toString()} (${previews}…)`);
  }
  return matches[0]!.id;
}

function formatFollowupList(
  payload: { readonly status: FollowupStatusFilter; readonly total: number },
  records: readonly PersistedFollowup[]
): string {
  if (records.length === 0) {
    return `No followups (status=${payload.status}).\n`;
  }
  const lines = records.map((entry) => {
    const id = entry.id.slice(0, 12);
    const when = entry.status === "fired" && entry.firedAt
      ? `fired ${shortDateTime(entry.firedAt)}`
      : entry.status === "cancelled"
        ? `cancelled (${entry.cancelReason ?? "no reason"})`
        : `due ${shortDateTime(entry.scheduledFor)}`;
    return `[${id}] ${entry.summary} — ${when}`;
  });
  return `${lines.join("\n")}\n`;
}

function formatFollowupDetail(record: PersistedFollowup): string {
  const lines = [
    `id:            ${record.id}`,
    `userId:        ${record.userId}`,
    `status:        ${record.status}`,
    `scheduledFor:  ${shortDateTime(record.scheduledFor)} (${record.scheduledFor})`,
    `createdAt:     ${shortDateTime(record.createdAt)} (${record.createdAt})`,
    `summary:       ${record.summary}`
  ];
  if (record.kind) lines.push(`kind:          ${record.kind}`);
  if (record.originRunId) lines.push(`originRunId:   ${record.originRunId}`);
  if (record.originTurnHash) lines.push(`originTurnHash:${record.originTurnHash}`);
  if (record.firedAt) lines.push(`firedAt:       ${shortDateTime(record.firedAt)} (${record.firedAt})`);
  if (record.cancelReason) lines.push(`cancelReason:  ${record.cancelReason}`);
  return `${lines.join("\n")}\n`;
}
