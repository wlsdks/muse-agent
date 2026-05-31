/**
 * Read-only shell-history grounding for `muse ask` (B3 perception, OPT-IN).
 * "What was that docker command I ran?" — a question only the user's own shell
 * history can answer. LOCAL + read-only; OPT-IN (default off) because history is
 * sensitive, and every injected command is secret-redacted by the caller before
 * it reaches the model. Pure parse + relevance match here; the file read and the
 * redaction live at the call site.
 */

import { lexicalTokens } from "@muse/agent-core";

/**
 * Parse a shell history file into commands, oldest→newest. Handles zsh EXTENDED
 * format (`: <epoch>:<dur>;<command>`) and plain one-command-per-line (bash /
 * basic zsh). Blank lines dropped; a trailing `\` continuation joins to the next
 * line. Never throws — a malformed line degrades to its raw text.
 */
export function parseShellHistory(raw: string): readonly string[] {
  const out: string[] = [];
  let pending: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    // zsh extended: ": 1700000000:0;the command"
    const ext = /^:\s*\d+:\d+;(.*)$/su.exec(line);
    const cmd = ext ? (ext[1] ?? "") : line;
    const text = pending !== undefined ? `${pending}\n${cmd}` : cmd;
    if (text.endsWith("\\")) {
      pending = text.slice(0, -1);
      continue;
    }
    pending = undefined;
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  if (pending !== undefined && pending.trim().length > 0) {
    out.push(pending.trim());
  }
  return out;
}

/**
 * The commands most relevant to the question — token overlap with the command
 * text, newest-first on a tie so the most recent matching run wins. Returns at
 * most `max`; 0-overlap commands are dropped so an unrelated question grounds on
 * nothing (→ honest refusal). De-duplicates identical commands (history repeats).
 */
export function selectShellCommands(
  commands: readonly string[],
  queryTokens: ReadonlySet<string>,
  max = 5
): readonly string[] {
  if (queryTokens.size === 0) {
    return [];
  }
  const scored = commands
    .map((command, index) => ({ command, index, score: overlap(command, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const entry of scored) {
    if (seen.has(entry.command)) {
      continue;
    }
    seen.add(entry.command);
    picked.push(entry.command);
    if (picked.length >= max) {
      break;
    }
  }
  return picked;
}

function overlap(command: string, queryTokens: ReadonlySet<string>): number {
  const tokens = lexicalTokens(command);
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}
