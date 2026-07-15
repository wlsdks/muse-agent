/**
 * `muse vetoes` — CLI surface for durable action vetoes (`~/.muse/vetoes.json`,
 * `@muse/stores` personal-veto-store). A veto is recorded when the user
 * undoes a logged autonomous action (P6-b2): "don't do that again" for that
 * {userId, objectiveId, scope} action class. Until this command existed the
 * backend (`queryVetoes` / `removeVeto`) had NO caller outside its own test —
 * reversing a veto meant hand-editing the JSON file, which fails
 * outbound-safety.md rule 4 ("every outbound action is subject to
 * undo/veto like any other autonomous action") in practice.
 */

import { queryVetoes, removeVeto, type ActionVeto } from "@muse/stores";
import { resolveVetoesFile } from "@muse/autoconfigure";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

function vetoesFile(): string {
  return resolveVetoesFile(process.env as Record<string, string | undefined>);
}

/**
 * `objectiveId`/`scope`/`reason` can originate from model-driven objective
 * text, not just user input — strip control/escape bytes and collapse any
 * embedded newline before they reach the terminal, so untrusted text can't
 * clear the screen, recolor it, or forge a fake section header in the audit
 * view this command exists to provide.
 */
function sanitizeForDisplay(value: string): string {
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
}

/** Render the veto list. Pure (data in, text out) so it is directly testable. */
export function formatVetoList(entries: readonly ActionVeto[]): string {
  if (entries.length === 0) {
    return "No vetoed actions — nothing Muse has been told 'never do that again' on.\n";
  }
  const lines = entries.map((v) => {
    const when = v.vetoedAt.slice(0, 10);
    const why = v.reason ? ` — ${sanitizeForDisplay(v.reason)}` : "";
    return `  [${v.id}] ${sanitizeForDisplay(v.objectiveId)} · ${sanitizeForDisplay(v.scope)}${why}  (vetoed ${when})`;
  });
  return `Vetoed actions (Muse won't auto-act on these again):\n${lines.join("\n")}\nWrong? → \`muse vetoes remove <id>\` lets Muse act on that class again.\n`;
}

export function registerVetoesCommands(program: Command, io: ProgramIO): void {
  const vetoes = program
    .command("vetoes")
    .description("Action classes Muse has learned NEVER to auto-act on again (`don't do that again`)");

  vetoes
    .command("list")
    .description("List learned avoidances — action classes vetoed by an undo")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--all", "Show vetoes for every user, not just yours")
    .option("--json", "Print the raw entries")
    .action(async (options: { readonly user?: string; readonly all?: boolean; readonly json?: boolean }) => {
      const userId = resolveDefaultUserKey({ override: options.user });
      const entries = await queryVetoes(vetoesFile(), options.all ? {} : { userId });
      if (options.json) {
        io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      io.stdout(formatVetoList(entries));
    });

  vetoes
    .command("remove")
    .description("Undo a veto by id — Muse may act on that class again (id from `muse vetoes list`). Scoped to your user by default; use --all for another user's veto")
    .argument("<id>", "Veto id (exact or unambiguous prefix)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--all", "Match across every user's vetoes, not just yours — confirm the exact id with `muse vetoes list --all` first")
    .option("--json", "Print { id, removed }")
    .action(async (id: string, options: { readonly user?: string; readonly all?: boolean; readonly json?: boolean }) => {
      const trimmed = id.trim();
      if (trimmed.length === 0) {
        throw new Error("vetoes remove needs a veto id (see `muse vetoes list`)");
      }
      const file = vetoesFile();
      const userId = resolveDefaultUserKey({ override: options.user });
      // Scoped by default so a bare id/prefix can never reach another user's
      // veto — reversing a veto re-enables an autonomous action class, so a
      // cross-user or ambiguous match is refused rather than guessed.
      const scoped = await queryVetoes(file, options.all ? {} : { userId });
      const exact = scoped.find((v) => v.id === trimmed);
      const candidates = exact ? [exact] : scoped.filter((v) => v.id.startsWith(trimmed));
      const scopeNote = options.all ? "" : ` for user ${userId}`;
      if (candidates.length === 0) {
        if (options.json) {
          io.stdout(`${JSON.stringify({ id: trimmed, removed: false }, null, 2)}\n`);
          return;
        }
        io.stdout(`(no veto matches "${trimmed}"${scopeNote})\n`);
        return;
      }
      if (candidates.length > 1) {
        const matchIds = candidates.map((v) => v.id);
        if (options.json) {
          io.stdout(`${JSON.stringify({ id: trimmed, removed: false, ambiguous: matchIds }, null, 2)}\n`);
        } else {
          io.stderr(`"${trimmed}" matches ${matchIds.length.toString()} vetoes${scopeNote} (${matchIds.join(", ")}) — be more specific.\n`);
        }
        process.exitCode = 1;
        return;
      }
      const match = candidates[0]!;
      const removed = await removeVeto(file, match.id);
      if (options.json) {
        io.stdout(`${JSON.stringify({ id: match.id, removed }, null, 2)}\n`);
        return;
      }
      io.stdout(removed
        ? `Removed veto [${match.id}] — Muse may act on this again.\n`
        : `(no veto matches "${trimmed}"${scopeNote})\n`);
    });
}
