/**
 * `muse inbox` — read-only inbox triage via the Gmail REST API.
 * Reads the most-recent inbox messages (no SDK, no new dep) and prints
 * a triage summary + listing. READ ONLY — no outbound-safety gate.
 *
 * The access token comes from `MUSE_GMAIL_TOKEN` (a Gmail OAuth2
 * access token with gmail.readonly scope). A guided `muse auth gmail`
 * flow is a future slice; for now the user supplies the token.
 */

import { resolveContactsFile } from "@muse/autoconfigure";
import { extractEmailAddress, GmailEmailProvider, queryContacts, summarizeInbox, type EmailMessage, type EmailProvider, type EmailReader, type EmailSummary } from "@muse/mcp";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { parseBoundedInt } from "./commands-ask.js";
import type { ProgramIO } from "./program.js";

interface InboxOptions {
  readonly limit?: string;
  readonly json?: boolean;
}

/**
 * A sender / subject / date is wholly attacker-controlled — anyone can
 * email you a header carrying raw ESC / C0 / C1 / DEL bytes — and these
 * land straight on the terminal via `muse inbox`. Strip the control
 * bytes and collapse whitespace to one line, the same boundary
 * treatment the feeds / search surfaces apply to untrusted text. (The
 * `--json` path is unaffected: `JSON.stringify` already escapes control
 * bytes to `\uXXXX`.)
 */
function cleanInboxField(value: string): string {
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
}

/** One inbox listing line: `●` unread, trailing `★` when the sender is a known contact. */
export function formatInboxLine(message: EmailSummary, known: boolean): string {
  const mark = message.unread ? "●" : " ";
  const star = known ? " ★" : "";
  return `${mark} ${cleanInboxField(message.from) || "(unknown)"} — ${cleanInboxField(message.subject) || "(no subject)"}${star}`;
}

/** Short id shown in the listing and accepted (as a prefix) by `muse inbox <id>`. */
function shortMessageId(id: string): string {
  return id.slice(0, 8);
}

/** Full read-out of one email — headers then the plain-text body. Pure so a test can pin it without HTTP. */
export function formatEmailMessage(message: EmailMessage): string {
  const lines = [
    `From:    ${cleanInboxField(message.from) || "(unknown)"}`,
    `Subject: ${cleanInboxField(message.subject) || "(no subject)"}`
  ];
  const date = cleanInboxField(message.date ?? "");
  if (date) {
    lines.push(`Date:    ${date}`);
  }
  // Strip ESC / C0 / C1 / DEL from the body but KEEP newlines + tabs
  // (stripUntrustedTerminalChars preserves \n and \t) so a multi-line
  // plain-text email stays readable — a hostile body still can't emit a
  // terminal-hijacking escape sequence.
  const body = stripUntrustedTerminalChars(message.body).trim();
  lines.push("", body.length > 0 ? body : "(no text body)");
  return lines.join("\n");
}

/**
 * Build a "is this sender a known contact?" predicate from the contacts
 * graph (matched by the sender's email address). Fail-soft: an
 * unreadable / absent contacts file yields a predicate that's always
 * false (no `★`, listing unchanged), never throws.
 */
export async function buildInboxKnownSender(env: Record<string, string | undefined>): Promise<(from: string) => boolean> {
  let known = new Set<string>();
  try {
    const contacts = await queryContacts(resolveContactsFile(env));
    known = new Set(contacts.flatMap((c) => (c.email ? [c.email.toLowerCase()] : [])));
  } catch {
    known = new Set();
  }
  return (from: string) => {
    const email = extractEmailAddress(from);
    return email !== undefined && known.has(email);
  };
}

export function registerInboxCommand(
  program: Command,
  io: ProgramIO,
  provider?: EmailProvider & Partial<EmailReader>,
  isKnownSender?: (from: string) => boolean
): void {
  program
    .command("inbox")
    .description("Read + triage your Gmail inbox (read-only; needs MUSE_GMAIL_TOKEN)")
    .argument("[id]", "A message id (the short id shown in the listing) to read its full body; omit to list the inbox")
    .option("--limit <n>", "How many recent messages to read (1-50, default 10)")
    .option("--json", "Emit the message summaries (or, with an id, the full message) as JSON")
    .action(async (id: string | undefined, options: InboxOptions) => {
      let email = provider;
      if (!email) {
        const token = process.env.MUSE_GMAIL_TOKEN?.trim();
        if (!token) {
          io.stderr("muse inbox: set MUSE_GMAIL_TOKEN to a Gmail OAuth2 access token (gmail.readonly scope).\n");
          process.exitCode = 1;
          return;
        }
        email = new GmailEmailProvider(token, io.fetch ?? globalThis.fetch);
      }

      const target = id?.trim();
      if (target && target.length > 0) {
        await readMessage(io, email, target, options.json ?? false);
        return;
      }

      const limit = parseBoundedInt(options.limit, "--limit", 1, 50, 10);
      let messages;
      try {
        messages = await email.listRecent(limit);
      } catch (cause) {
        io.stderr(`muse inbox: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(messages, null, 2)}\n`);
        return;
      }
      const known = isKnownSender ?? await buildInboxKnownSender(process.env as Record<string, string | undefined>);
      io.stdout(`${summarizeInbox(messages)}\n`);
      for (const message of messages) {
        io.stdout(`[${shortMessageId(message.id)}] ${formatInboxLine(message, known(message.from))}\n`);
      }
    });
}

/**
 * Read one message's full body. `target` is the short id shown in the
 * listing (or a full id) — resolved against the recent inbox to its
 * full Gmail id, then fetched via {@link EmailReader.getMessage}.
 * Read-only and fail-soft: an unknown id / unsupported provider exits 1
 * without throwing.
 */
async function readMessage(
  io: ProgramIO,
  email: EmailProvider & Partial<EmailReader>,
  target: string,
  json: boolean
): Promise<void> {
  if (!email.getMessage) {
    io.stderr("muse inbox: this provider can't read a single message.\n");
    process.exitCode = 1;
    return;
  }
  let recent;
  try {
    recent = await email.listRecent(50);
  } catch (cause) {
    io.stderr(`muse inbox: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
    return;
  }
  const match = recent.find((m) => m.id === target) ?? recent.find((m) => m.id.startsWith(target));
  if (!match) {
    io.stderr(`muse inbox: no message in your recent inbox matches id '${target}'.\n`);
    process.exitCode = 1;
    return;
  }
  let full: EmailMessage | undefined;
  try {
    full = await email.getMessage(match.id);
  } catch (cause) {
    io.stderr(`muse inbox: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!full) {
    io.stderr(`muse inbox: message '${target}' could not be read.\n`);
    process.exitCode = 1;
    return;
  }
  io.stdout(json ? `${JSON.stringify(full, null, 2)}\n` : `${formatEmailMessage(full)}\n`);
}
