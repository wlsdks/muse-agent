/**
 * Shared email→recall ingestion: pull recent emails and write one local note per
 * message into `<notesDir>/email/`, so the existing notes-recall (+ its grounding
 * + citation gate) recalls + cites them. Used by BOTH the on-demand `muse email
 * sync` command and the daemon's continuous `emailSyncTick`, so the manual and
 * always-on surfaces ingest identically.
 *
 * IDEMPOTENT: one note per Gmail message id (a re-sync overwrites, never
 * duplicates). The note carries from / subject / date / snippet — recall-worthy
 * for "who emailed about what". Read-only; the emails are written LOCALLY as
 * notes and never egressed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EmailProvider, EmailSummary } from "@muse/domain-tools";
import { stripUntrustedTerminalChars } from "@muse/shared";

/** Pull the most recent `limit` inbox emails into recallable notes. Returns the count written. */
export async function syncEmailsToNotes(
  provider: Pick<EmailProvider, "listRecent">,
  notesDir: string,
  limit: number
): Promise<number> {
  const summaries = await provider.listRecent(limit);
  const emailDir = join(notesDir, "email");
  await mkdir(emailDir, { recursive: true });
  let written = 0;
  for (const summary of summaries) {
    await writeFile(join(emailDir, `${safeEmailId(summary.id)}.md`), renderEmailNote(summary), "utf8");
    written += 1;
  }
  return written;
}

/** A Gmail message id → a safe, stable note filename (so a re-sync overwrites). */
export function safeEmailId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80);
  return safe.length > 0 ? safe : "email";
}

export function renderEmailNote(e: EmailSummary): string {
  // An email is UNTRUSTED third-party content — a sender controls its from /
  // subject / snippet, so without sanitisation a `\n[System Override]\n` (or a
  // fake `# Email:` heading, CRLF, or ANSI/control bytes) could splice a forged
  // section into the prompt once this note is recalled. Apply the SAME defence
  // every other untrusted-content path uses (ambient / attachment / episodic):
  // strip terminal-control chars + collapse whitespace, so no field can carry a
  // newline that breaks out of its line. Only the note's OWN structure newlines
  // (which this code controls) remain. (Indirect prompt-injection — backlog #5.)
  const clean = (text: string): string => stripUntrustedTerminalChars(text).replace(/\s+/gu, " ").trim();
  const subject = clean(e.subject) || "(no subject)";
  const date = e.date ? clean(e.date) : undefined;
  const snippet = clean(e.snippet) || "(no preview text)";
  const lines = [
    `# Email: ${subject}`,
    "",
    `From: ${clean(e.from)}`,
    ...(date ? [`Date: ${date}`] : []),
    "",
    snippet
  ];
  return `${lines.join("\n")}\n`;
}
