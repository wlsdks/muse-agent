/**
 * `muse email send` — draft-first, fail-closed outbound email.
 * Resolves the recipient via the contacts graph, shows the EXACT
 * draft, and only sends on explicit confirmation (per
 * `.claude/rules/outbound-safety.md`). All gating lives in
 * `sendEmailWithApproval` (@muse/mcp); this is the CLI surface.
 */

import { resolveActionLogFile, resolveContactsFile } from "@muse/autoconfigure";
import {
  GmailEmailProvider,
  queryContacts,
  sendEmailWithApproval,
  type EmailApprovalGate,
  type EmailSender
} from "@muse/mcp";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface SendOptions {
  readonly to?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly user?: string;
}

export interface EmailCommandDeps {
  readonly approvalGate?: EmailApprovalGate;
  readonly sender?: EmailSender;
  readonly contactsFile?: string;
  readonly actionLogFile?: string;
}

export function registerEmailCommands(program: Command, io: ProgramIO, deps: EmailCommandDeps = {}): void {
  const email = program.command("email").description("Outbound email (draft-first, confirmation-gated)");

  email
    .command("send")
    .description("Draft an email to a contact and send it only after you confirm the exact content")
    .requiredOption("--to <name>", "Recipient name (resolved via your contacts)")
    .requiredOption("--subject <text>", "Subject line")
    .requiredOption("--body <text>", "Message body")
    .option("--user <id>", "User identity for the action log", "stark")
    .action(async (options: SendOptions) => {
      const sender = deps.sender ?? buildGmailSender(io);
      if (!sender) {
        io.stderr("muse email send: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.send scope).\n");
        process.exitCode = 1;
        return;
      }
      const contactsFile = deps.contactsFile ?? resolveContactsFile(process.env as Record<string, string | undefined>);
      const gate: EmailApprovalGate = deps.approvalGate ?? ((draft) => {
        io.stdout(`\nTo: ${draft.recipientName} <${draft.to}>\nSubject: ${draft.subject}\n\n${draft.body}\n\n`);
        return confirm({ message: "Send this email?" }).then((answer) =>
          isCancel(answer) || answer !== true
            ? { approved: false, reason: "user did not confirm" }
            : { approved: true });
      });

      const outcome = await sendEmailWithApproval({
        actionLogFile: deps.actionLogFile ?? resolveActionLogFile(process.env as Record<string, string | undefined>),
        approvalGate: gate,
        body: options.body ?? "",
        contacts: await queryContacts(contactsFile),
        recipientQuery: options.to ?? "",
        sender,
        subject: options.subject ?? "",
        userId: options.user ?? "stark"
      });

      if (outcome.sent) {
        io.stdout(`Sent to ${outcome.to}.\n`);
        return;
      }
      if (outcome.reason === "ambiguous-recipient") {
        io.stderr(`'${options.to}' is ambiguous — did you mean one of:\n`);
        for (const c of outcome.candidates ?? []) {
          io.stderr(`  - ${c.name}${c.email ? ` <${c.email}>` : ""}\n`);
        }
      } else {
        io.stderr(`Not sent (${outcome.reason}): ${outcome.detail}\n`);
      }
      process.exitCode = 1;
    });
}

function buildGmailSender(io: ProgramIO): EmailSender | undefined {
  const token = process.env.MUSE_GMAIL_TOKEN?.trim();
  if (!token) {
    return undefined;
  }
  return new GmailEmailProvider(token, io.fetch ?? globalThis.fetch);
}
