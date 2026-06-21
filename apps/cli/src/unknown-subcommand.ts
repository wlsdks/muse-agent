import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";

/**
 * Prefix fallback for a subcommand suggestion: users abbreviate
 * (`muse memory sea` → `search`), which pure Levenshtein misses once the
 * abbreviation is several edits short. Only suggest when EXACTLY ONE
 * subcommand has the prefix — an ambiguous prefix stays silent rather than
 * guess wrong.
 */
function uniqueSubPrefix(input: string, subs: readonly string[]): string | undefined {
  const prefix = input.trim().toLowerCase();
  if (prefix.length < 2) return undefined;
  const matches = subs.filter((name) => name.toLowerCase().startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The stderr block for an unknown `muse <group> <attempted>` (e.g.
 * `muse memory bogus`). Commander's stock "error: unknown command 'bogus'"
 * is a dead end — it names neither the group nor the valid subcommands. A
 * close / unique-prefix match gets a "Did you mean" nudge, then the real
 * subcommand list (GROUNDED in `knownSubs`, so fabrication 0) is shown.
 * Pure + exported so the guidance is gradeable without spawning the CLI.
 */
export function formatUnknownSubcommand(
  group: string,
  attempted: string,
  knownSubs: readonly string[]
): string {
  const suggestion = closestCommandName(attempted, knownSubs) ?? uniqueSubPrefix(attempted, knownSubs);
  const lines = [`error: unknown command 'muse ${group} ${attempted}'`];
  if (suggestion) {
    lines.push(`Did you mean 'muse ${group} ${suggestion}'?`);
  }
  if (knownSubs.length > 0) {
    lines.push(`Available ${group} commands: ${knownSubs.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Wire the grounded unknown-subcommand block onto every command GROUP (a
 * command that owns subcommands). Commander emits `command:*` on such a
 * group — only when the group has no default action, which holds for all of
 * Muse's pure container groups — so a typo'd subcommand prints the block
 * instead of the stock error. Groups that DON'T emit it are left unchanged
 * (no regression). The subcommand list is read from the LIVE registry, so
 * the guidance can only ever name subcommands that actually exist.
 */
export function attachUnknownSubcommandGuidance(
  program: Command,
  stderr: (text: string) => void
): void {
  for (const group of program.commands) {
    const subs = group.commands
      .map((sub) => sub.name())
      .filter((name): name is string => Boolean(name) && name !== "*");
    if (subs.length === 0) continue;
    const knownSubs = [...subs].sort();
    const groupName = group.name();
    group.on("command:*", (operands: readonly string[]) => {
      const attempted = operands[0] ?? "";
      stderr(`${formatUnknownSubcommand(groupName, attempted, knownSubs)}\n`);
      process.exitCode = 1;
    });
  }
}
