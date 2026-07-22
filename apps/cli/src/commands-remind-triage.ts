import { resolveReminderTriageFile, resolveRemindersFile } from "@muse/autoconfigure";
import {
  confirmReminderTriage,
  previewReminderTriage,
  type ReminderTriageAction,
  type ReminderTriagePreview,
  type ReminderTriageResult
} from "@muse/stores";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface TriageCommandHelpers {
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function formatReminderTriagePreview(preview: ReminderTriagePreview): string {
  const lines = [`Preview ${preview.action} for ${preview.items.length.toString()} reminder(s):`];
  for (const item of preview.items) {
    const recurrence = item.recurrence ? ` (recurring=${item.recurrence})` : "";
    const event = item.eventId ? ` (event=${item.eventId})` : "";
    lines.push(`  - [${item.id}] ${item.text.replace(/[\r\n\t]/gu, " ")} — due ${new Date(item.dueAt).toISOString()}${recurrence}${event}`);
  }
  lines.push(`Expires: ${preview.expiresAt}`, `Confirm token: ${preview.confirmToken}`);
  return `${lines.join("\n")}\n`;
}

export function formatReminderTriageResult(result: ReminderTriageResult): string {
  if (result.status === "conflict") {
    return `Triage conflict: ${result.outcome} (operation ${result.operationId}); no new reminder change was made.\n`;
  }
  const header = `Applied ${result.action} to ${result.items.length.toString()} reminder(s) (operation ${result.operationId}, outcome ${result.outcome}).\n`;
  return result.digestDraft ? `${header}${result.digestDraft}` : header;
}

/** Local-only handler: intentionally has no messaging, API, model, or reminder-history dependency. */
export function registerReminderTriageCommands(remind: Command, io: ProgramIO, helpers: TriageCommandHelpers): void {
  const triage = remind.command("triage").description("Explicit local preview/confirm triage for due reminder backlogs");
  triage
    .command("preview")
    .description("Persist an exact local preview and issue a short-lived confirmation token")
    .argument("<action>", "dismiss | snooze | retain | draft-digest")
    .argument("<ids...>", "1 to 20 exact reminder ids")
    .requiredOption("--local", "Required: operate only on the local owner store")
    .option("--snooze-at <iso>", "Required for snooze: exact future ISO-8601 instant")
    .option("--json", "Print the versioned preview object")
    .action(async (actionRaw: string, ids: readonly string[], options: { readonly local: boolean; readonly snoozeAt?: string; readonly json?: boolean }) => {
      if (!options.local) throw new Error("reminder triage is local-only; pass --local");
      if (actionRaw !== "dismiss" && actionRaw !== "snooze" && actionRaw !== "retain" && actionRaw !== "draft-digest") {
        throw new Error("triage action must be dismiss, snooze, retain, or draft-digest");
      }
      const environment = process.env as Record<string, string | undefined>;
      const preview = await previewReminderTriage({
        action: actionRaw as ReminderTriageAction,
        ids,
        ledgerFile: resolveReminderTriageFile(environment),
        remindersFile: resolveRemindersFile(environment),
        ...(options.snoozeAt ? { snoozeAt: options.snoozeAt } : {})
      });
      if (options.json) helpers.writeOutput(io, preview);
      else io.stdout(formatReminderTriagePreview(preview));
    });
  triage
    .command("confirm")
    .description("Apply or recover one exact triage preview; retries are idempotent")
    .argument("<token>", "Opaque token printed by triage preview")
    .requiredOption("--local", "Required: operate only on the local owner store")
    .option("--json", "Print the stored versioned result")
    .action(async (token: string, options: { readonly local: boolean; readonly json?: boolean }) => {
      if (!options.local) throw new Error("reminder triage is local-only; pass --local");
      const environment = process.env as Record<string, string | undefined>;
      const result = await confirmReminderTriage({
        ledgerFile: resolveReminderTriageFile(environment),
        remindersFile: resolveRemindersFile(environment),
        token
      });
      if (options.json) helpers.writeOutput(io, result);
      else io.stdout(formatReminderTriageResult(result));
    });
}
