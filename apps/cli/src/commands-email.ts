/**
 * `muse email send` — draft-first, fail-closed outbound email.
 * Resolves the recipient via the contacts graph, shows the EXACT
 * draft, and only sends on explicit confirmation (per
 * `.claude/rules/outbound-safety.md`). All gating lives in
 * `sendEmailWithApproval` (@muse/mcp); this is the CLI surface.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveActionLogFile, resolveContactsFile, resolveNotesDir } from "@muse/autoconfigure";
import {
  GmailEmailProvider,
  queryContacts,
  sendEmailWithApproval,
  type EmailApprovalGate,
  type EmailProvider,
  type EmailSender,
  type EmailSummary
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
  /** Test seam for `email sync` — a contract-faithful real GmailEmailProvider with a fake fetch. */
  readonly emailSource?: EmailProvider;
  readonly notesDir?: string;
}

export function registerEmailCommands(program: Command, io: ProgramIO, deps: EmailCommandDeps = {}): void {
  const email = program.command("email").description("Email — sync your inbox into recall (`sync`) + draft-first send (`send`)");

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

  email
    .command("sync")
    .description("Pull your recent emails into local notes so `muse ask` can recall them (Gmail; needs MUSE_GMAIL_TOKEN, read-only)")
    .option("--limit <n>", "How many recent inbox emails to sync (default 20, max 100)", "20")
    .action(async (options: { readonly limit?: string }) => {
      const provider = deps.emailSource ?? buildGmailReader(io);
      if (!provider) {
        io.stderr("muse email sync: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.readonly scope).\n");
        process.exitCode = 1;
        return;
      }
      const raw = Number((options.limit ?? "20").trim());
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.trunc(raw)) : 20;
      let summaries: readonly EmailSummary[];
      try {
        summaries = await provider.listRecent(limit);
      } catch (cause) {
        io.stderr(`muse email sync: could not read Gmail (${cause instanceof Error ? cause.message : String(cause)}).\n`);
        process.exitCode = 1;
        return;
      }
      const emailDir = join(deps.notesDir ?? resolveNotesDir(process.env as Record<string, string | undefined>), "email");
      await mkdir(emailDir, { recursive: true });
      let written = 0;
      for (const summary of summaries) {
        // Idempotent: one note per Gmail message id, so a re-sync overwrites
        // rather than duplicating. The note carries from/subject/date/snippet so
        // the existing notes-recall (and its citation gate) grounds on it.
        await writeFile(join(emailDir, `${safeEmailId(summary.id)}.md`), renderEmailNote(summary), "utf8");
        written += 1;
      }
      io.stdout(
        written === 0
          ? "No emails to sync (your inbox read returned nothing).\n"
          : `Synced ${written.toString()} email${written === 1 ? "" : "s"} into ${emailDir}. ` +
            `Ask about them, e.g. \`muse ask "what did <person> email me about?"\`.\n`
      );
    });
}

function buildGmailReader(io: ProgramIO): EmailProvider | undefined {
  const token = process.env.MUSE_GMAIL_TOKEN?.trim();
  return token ? new GmailEmailProvider(token, io.fetch ?? globalThis.fetch) : undefined;
}

/** A Gmail message id → a safe, stable note filename (so a re-sync overwrites). */
function safeEmailId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80);
  return safe.length > 0 ? safe : "email";
}

function renderEmailNote(e: EmailSummary): string {
  const lines = [
    `# Email: ${e.subject || "(no subject)"}`,
    "",
    `From: ${e.from}`,
    ...(e.date ? [`Date: ${e.date}`] : []),
    "",
    e.snippet || "(no preview text)"
  ];
  return `${lines.join("\n")}\n`;
}

function buildGmailSender(io: ProgramIO): EmailSender | undefined {
  const token = process.env.MUSE_GMAIL_TOKEN?.trim();
  if (!token) {
    return undefined;
  }
  return new GmailEmailProvider(token, io.fetch ?? globalThis.fetch);
}
