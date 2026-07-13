/**
 * `muse email send` — draft-first, fail-closed outbound email.
 * Resolves the recipient via the contacts graph, shows the EXACT
 * draft, and only sends on explicit confirmation (per
 * `.claude/rules/outbound-safety.md`). All gating lives in
 * `sendEmailWithApproval` (@muse/mcp); this is the CLI surface.
 */

import { join } from "node:path";

import { resolveActionLogFile, resolveContactsFile, resolveNotesDir, type MuseEnvironment } from "@muse/autoconfigure";
import { isLocalOnlyEnabled } from "@muse/model";
import { queryContacts } from "@muse/stores";
import { GmailEmailProvider, extractEmailAddress, composeForward, replyEmailWithApproval, replySubject, sendEmailWithApproval, type EmailApprovalGate, type EmailProvider, type EmailReader, type EmailSender } from "@muse/domain-tools";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";

import { syncEmailsToNotes } from "./email-sync.js";
import type { ProgramIO } from "./program.js";

interface SendOptions {
  readonly to?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly user?: string;
}

export interface EmailCommandDeps {
  /** Test-only env seam. Public CLI continues to use process.env. */
  readonly env?: MuseEnvironment;
  readonly approvalGate?: EmailApprovalGate;
  readonly sender?: EmailSender;
  /** Test seam for `email reply` — reads the message being replied to. */
  readonly reader?: EmailReader;
  readonly contactsFile?: string;
  readonly actionLogFile?: string;
  /** Test seam for `email sync` — a contract-faithful real GmailEmailProvider with a fake fetch. */
  readonly emailSource?: EmailProvider;
  readonly notesDir?: string;
}

export function registerEmailCommands(program: Command, io: ProgramIO, deps: EmailCommandDeps = {}): void {
  const env: MuseEnvironment = deps.env ?? process.env;
  const rejectWhenLocalOnly = (mode: "send" | "reply" | "forward" | "sync"): boolean => {
    // A dependency-injected env is a test/composition input, not an opt-out
    // capability. It may tighten ambient false, but cannot reopen Gmail when
    // the process itself is already local-only.
    if (!isLocalOnlyEnabled(process.env) && !isLocalOnlyEnabled(env)) {
      return false;
    }
    io.stderr(`muse email ${mode}: Gmail is disabled while MUSE_LOCAL_ONLY=true. This does not disable other integration surfaces.\n`);
    process.exitCode = 1;
    return true;
  };
  const email = program.command("email").description("Email — sync your inbox into recall (`sync`) + draft-first send / reply / forward");

  email
    .command("send")
    .description("Draft an email to a contact and send it only after you confirm the exact content")
    .requiredOption("--to <name>", "Recipient name (resolved via your contacts)")
    .requiredOption("--subject <text>", "Subject line")
    .requiredOption("--body <text>", "Message body")
    .option("--user <id>", "User identity for the action log", "stark")
    .action(async (options: SendOptions) => {
      if (rejectWhenLocalOnly("send")) return;
      const sender = deps.sender ?? buildGmailSender(io, env);
      if (!sender) {
        io.stderr("muse email send: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.send scope).\n");
        process.exitCode = 1;
        return;
      }
      const contactsFile = deps.contactsFile ?? resolveContactsFile(env);
      const gate: EmailApprovalGate = deps.approvalGate ?? ((draft) => {
        io.stdout(`\nTo: ${draft.recipientName} <${draft.to}>\nSubject: ${draft.subject}\n\n${draft.body}\n\n`);
        return confirm({ message: "Send this email?" }).then((answer) =>
          isCancel(answer) || answer !== true
            ? { approved: false, reason: "user did not confirm" }
            : { approved: true });
      });

      const outcome = await sendEmailWithApproval({
        actionLogFile: deps.actionLogFile ?? resolveActionLogFile(env),
        approvalGate: gate,
        body: options.body ?? "",
        contacts: await queryContacts(contactsFile),
        recipientQuery: options.to ?? "",
        sender,
        subject: options.subject ?? "",
        userId: options.user ?? "stark"
      });

      if (outcome.sent) {
        io.stdout(`Sent to ${outcome.to}.${outcome.messageId ? ` (id: ${outcome.messageId})` : ""}\n`);
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
    .command("reply")
    .description("Reply to a received email by its id — drafts the reply to the original sender (Re:) and sends only after you confirm")
    .requiredOption("--id <id>", "Id of the message to reply to (from your mail client / `muse email sync`)")
    .requiredOption("--body <text>", "The reply text to send back to the sender")
    .option("--user <id>", "User identity for the action log", "stark")
    .action(async (options: { readonly id?: string; readonly body?: string; readonly user?: string }) => {
      if (rejectWhenLocalOnly("reply")) return;
      const provider = buildGmailProvider(io, env);
      const reader = deps.reader ?? provider;
      const sender = deps.sender ?? provider;
      if (!reader || !sender) {
        io.stderr("muse email reply: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.send scope).\n");
        process.exitCode = 1;
        return;
      }
      const message = await reader.getMessage(options.id ?? "");
      if (!message) {
        io.stderr(`muse email reply: no message with id '${options.id ?? ""}' — check the id.\n`);
        process.exitCode = 1;
        return;
      }
      const to = extractEmailAddress(message.from);
      if (!to) {
        io.stderr(`muse email reply: couldn't determine a reply address from the sender '${message.from}'.\n`);
        process.exitCode = 1;
        return;
      }
      const subject = replySubject(message.subject);
      const gate: EmailApprovalGate = deps.approvalGate ?? ((draft) => {
        io.stdout(`\nTo: ${draft.recipientName} <${draft.to}>\nSubject: ${draft.subject}\n\n${draft.body}\n\n`);
        return confirm({ message: "Send this reply?" }).then((answer) =>
          isCancel(answer) || answer !== true
            ? { approved: false, reason: "user did not confirm" }
            : { approved: true });
      });
      const outcome = await replyEmailWithApproval({
        actionLogFile: deps.actionLogFile ?? resolveActionLogFile(env),
        approvalGate: gate,
        body: options.body ?? "",
        recipientName: message.from,
        sender,
        subject,
        to,
        userId: options.user ?? "stark"
      });
      if (outcome.sent) {
        io.stdout(`Replied to ${outcome.to}.${outcome.messageId ? ` (id: ${outcome.messageId})` : ""}\n`);
        return;
      }
      io.stderr(`Not sent (${outcome.reason}): ${outcome.detail}\n`);
      process.exitCode = 1;
    });

  email
    .command("forward")
    .description("Forward a received email (by id) to a contact — drafts it (Fwd: + quoted original) and sends only after you confirm")
    .requiredOption("--id <id>", "Id of the message to forward (from your mail client / `muse email sync`)")
    .requiredOption("--to <name>", "Recipient contact name (resolved via your contacts)")
    .option("--note <text>", "Optional note to prepend above the forwarded message")
    .option("--user <id>", "User identity for the action log", "stark")
    .action(async (options: { readonly id?: string; readonly to?: string; readonly note?: string; readonly user?: string }) => {
      if (rejectWhenLocalOnly("forward")) return;
      const provider = buildGmailProvider(io, env);
      const reader = deps.reader ?? provider;
      const sender = deps.sender ?? provider;
      if (!reader || !sender) {
        io.stderr("muse email forward: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.send scope).\n");
        process.exitCode = 1;
        return;
      }
      const message = await reader.getMessage(options.id ?? "");
      if (!message) {
        io.stderr(`muse email forward: no message with id '${options.id ?? ""}' — check the id.\n`);
        process.exitCode = 1;
        return;
      }
      const { body, subject } = composeForward(message, options.note);
      const contactsFile = deps.contactsFile ?? resolveContactsFile(env);
      const gate: EmailApprovalGate = deps.approvalGate ?? ((draft) => {
        io.stdout(`\nTo: ${draft.recipientName} <${draft.to}>\nSubject: ${draft.subject}\n\n${draft.body}\n\n`);
        return confirm({ message: "Forward this email?" }).then((answer) =>
          isCancel(answer) || answer !== true
            ? { approved: false, reason: "user did not confirm" }
            : { approved: true });
      });
      const outcome = await sendEmailWithApproval({
        actionLogFile: deps.actionLogFile ?? resolveActionLogFile(env),
        approvalGate: gate,
        body,
        contacts: await queryContacts(contactsFile),
        recipientQuery: options.to ?? "",
        sender,
        subject,
        userId: options.user ?? "stark"
      });
      if (outcome.sent) {
        io.stdout(`Forwarded to ${outcome.to}.${outcome.messageId ? ` (id: ${outcome.messageId})` : ""}\n`);
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
      if (rejectWhenLocalOnly("sync")) return;
      const provider = deps.emailSource ?? buildGmailReader(io, env);
      if (!provider) {
        io.stderr("muse email sync: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.readonly scope).\n");
        process.exitCode = 1;
        return;
      }
      const raw = Number((options.limit ?? "20").trim());
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.trunc(raw)) : 20;
      const notesDir = deps.notesDir ?? resolveNotesDir(env);
      let written: number;
      try {
        written = await syncEmailsToNotes(provider, notesDir, limit);
      } catch (cause) {
        io.stderr(`muse email sync: could not read Gmail (${cause instanceof Error ? cause.message : String(cause)}).\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(
        written === 0
          ? "No emails to sync (your inbox read returned nothing).\n"
          : `Synced ${written.toString()} email${written === 1 ? "" : "s"} into ${join(notesDir, "email")}. ` +
            `Ask about them, e.g. \`muse ask "what did <person> email me about?"\`.\n`
      );
    });
}

function buildGmailReader(io: ProgramIO, env: MuseEnvironment): EmailProvider | undefined {
  const token = env.MUSE_GMAIL_TOKEN?.trim();
  return token ? new GmailEmailProvider(token, io.fetch ?? globalThis.fetch) : undefined;
}

function buildGmailProvider(io: ProgramIO, env: MuseEnvironment): GmailEmailProvider | undefined {
  const token = env.MUSE_GMAIL_TOKEN?.trim();
  if (!token) {
    return undefined;
  }
  return new GmailEmailProvider(token, io.fetch ?? globalThis.fetch);
}

function buildGmailSender(io: ProgramIO, env: MuseEnvironment): EmailSender | undefined {
  return buildGmailProvider(io, env);
}
