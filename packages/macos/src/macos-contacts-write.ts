/**
 * Tier 2: `mac_contacts_write` — adds a new person to Apple Contacts.app.
 * A write to the user's own address book is not trivially undoable, so it
 * follows the SAME draft-first, fail-closed contract as `mac_message_send`
 * (`.claude/rules/outbound-safety.md`): the exact contact is shown to the
 * user and NOTHING is created — no osascript runs at all — until the
 * approval gate returns `approved: true`. A denied, timed-out, or throwing
 * gate is indistinguishable from "no write happened".
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultOsascriptRunner, escapeAppleScript, isPermissionError, OSASCRIPT_TIMEOUT_MS, type MacCommandResult, type MacOsascriptRunner } from "./macos-exec.js";

export interface ContactDraft {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface ContactApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Presents the EXACT contact to be created to the user; returns approve/deny. */
export type ContactApprovalGate = (draft: ContactDraft) => Promise<ContactApprovalDecision> | ContactApprovalDecision;

export type MacContactsActionResult = "performed" | "refused" | "failed";

/**
 * Structurally identical to `@muse/macos`'s `MacActionLogEntry` (and
 * `@muse/stores`'s `ActionLogEntry`), so the CLI's existing
 * `appendActionLog`-backed logger passes straight in.
 */
export interface MacContactsActionLogEntry {
  readonly id: string;
  readonly userId: string;
  readonly when: string;
  readonly what: string;
  readonly why: string;
  readonly result: MacContactsActionResult;
  readonly detail?: string;
}

export type MacContactsActionLogger = (entry: MacContactsActionLogEntry) => Promise<void> | void;

export interface MacContactsWriteToolDeps {
  readonly approvalGate: ContactApprovalGate;
  /** Records the outcome (created OR refused) — injected by the CLI (outbound-safety Rule 4). */
  readonly actionLog?: MacContactsActionLogger;
  readonly userId?: string;
  readonly osascript?: MacOsascriptRunner;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export function createMacContactsWriteTool(deps: MacContactsWriteToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Add a new contact to the user's Apple Contacts. Use when the user asks to save someone's number/email " +
        "as a contact (e.g. 'save Ada's number as a contact', '연락처에 지안 추가해줘'). The user MUST confirm the " +
        "exact contact before it is created; absent confirmation nothing is written. Do NOT use to send a " +
        "message (that is mac_message_send) or to look up an existing contact (that is mac_app_read).",
      groundedArgs: ["name", "phone", "email"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          email: { description: "The contact's email address, e.g. 'ada@example.com'.", type: "string" },
          name: { description: "The contact's full name, e.g. 'Ada Lovelace'.", type: "string" },
          phone: { description: "The contact's phone number, e.g. '+1 555 0100'.", type: "string" }
        },
        required: ["name"],
        type: "object"
      },
      keywords: ["contact", "연락처", "address book", "save number", "add contact"],
      name: "mac_contacts_write",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      const phone = typeof args["phone"] === "string" ? args["phone"].trim() : "";
      const email = typeof args["email"] === "string" ? args["email"].trim() : "";

      // Nothing to write — fail before the gate even runs (no draft to show).
      if (name.length === 0) {
        return { detail: "mac_contacts_write requires a non-empty 'name'.", reason: "empty-name", written: false };
      }

      const now = deps.now ?? (() => new Date());
      const idFactory = deps.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
      const runner = deps.osascript ?? defaultOsascriptRunner;
      const userId = deps.userId ?? "local";
      const what = `Contact: ${name}`;
      const log = (result: MacContactsActionResult, why: string, detail: string): Promise<void> | void =>
        deps.actionLog?.({ detail, id: idFactory(), result, userId, what, when: now().toISOString(), why });

      const draft: ContactDraft = {
        name,
        ...(phone.length > 0 ? { phone } : {}),
        ...(email.length > 0 ? { email } : {})
      };

      let decision: ContactApprovalDecision;
      try {
        decision = await deps.approvalGate(draft);
      } catch (cause) {
        decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      // The load-bearing gate: NO osascript below this line unless approved.
      if (!decision.approved) {
        await log("refused", "contact creation refused (not confirmed)", decision.reason ?? "not approved");
        return { detail: decision.reason ?? "not approved", reason: "denied", written: false };
      }

      const scriptLines = [
        `tell application "Contacts"`,
        `  set newPerson to make new person with properties {first name:"${escapeAppleScript(name)}"}`,
        ...(phone.length > 0
          ? [`  make new phone at end of phones of newPerson with properties {value:"${escapeAppleScript(phone)}"}`]
          : []),
        ...(email.length > 0
          ? [`  make new email at end of emails of newPerson with properties {value:"${escapeAppleScript(email)}"}`]
          : []),
        `  save`,
        `end tell`
      ];
      const script = scriptLines.join("\n");

      let result: MacCommandResult;
      try {
        result = await runner(script);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        await log("failed", "user-approved contact creation", detail);
        return { detail, reason: "write-failed", written: false };
      }
      if (result.timedOut) {
        const detail = `osascript timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms`;
        await log("failed", "user-approved contact creation", detail);
        return { detail, reason: "write-failed", written: false };
      }
      if (result.exitCode !== 0) {
        const detail = isPermissionError(result.stderr)
          ? "permission denied for Contacts — grant access in System Settings → Privacy & Security → Automation"
          : (result.stderr.trim().slice(0, 300) || `osascript exited with code ${result.exitCode?.toString() ?? "null"}`);
        await log("failed", "user-approved contact creation", detail);
        return { detail, reason: "write-failed", written: false };
      }
      await log("performed", "user-approved contact creation", `created: ${name}`);
      return { name, written: true };
    }
  };
}
