/**
 * `muse completion <shell>` emits a shell completion script for
 * bash / zsh. It completes the top-level verb AND the second-level
 * subcommand for groups that have one (`muse calendar <tab>` →
 * `add delete edit events show`). Flag/value completion stays out
 * of scope — it needs per-shell `_arguments` machinery with sharply
 * diminishing returns. Both levels are enumerated live from the
 * command tree, so a new command or subcommand appears with no edit
 * here.
 *
 * Usage:
 *   muse completion bash >> ~/.bashrc
 *   muse completion zsh  > "${fpath[1]}/_muse"   # zsh fpath
 */

import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

type SupportedShell = "bash" | "zsh";
const SUPPORTED_SHELLS: readonly SupportedShell[] = ["bash", "zsh"];

/**
 * Enumerate the program's top-level subcommand names so the
 * generated script reflects the current CLI surface (additive
 * goals automatically appear). Exported for direct unit-test
 * coverage.
 */
export function collectTopLevelCommandNames(program: Command): readonly string[] {
  return program.commands
    .map((cmd) => cmd.name())
    .filter((name) => typeof name === "string" && name.length > 0)
    .sort();
}

/**
 * Map each top-level command that owns subcommands to its sorted
 * subcommand names. Commands with no children are omitted entirely
 * so the rendered script only branches where there's something to
 * complete. Enumerated from the live tree (`cmd.commands`) so an
 * added subcommand appears automatically. Exported for direct
 * unit-test coverage.
 */
export function collectSubcommandMap(program: Command): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const cmd of program.commands) {
    const parent = cmd.name();
    if (typeof parent !== "string" || parent.length === 0) continue;
    const subs = cmd.commands
      .map((sub) => sub.name())
      .filter((name) => typeof name === "string" && name.length > 0)
      .sort();
    if (subs.length > 0) {
      map.set(parent, subs);
    }
  }
  return map;
}

/**
 * Render the bash completion script. Completes the top-level verb at
 * word 1 and, at word 2, the subcommands of whichever group was
 * typed (via a `case` on `${COMP_WORDS[1]}`). Pure function so the
 * unit test can assert the structural shape without running the CLI.
 */
export function renderBashCompletion(
  commandNames: readonly string[],
  subcommands: ReadonlyMap<string, readonly string[]> = new Map()
): string {
  const subs = commandNames.join(" ");
  const caseArms: string[] = [];
  for (const parent of [...subcommands.keys()].sort()) {
    const children = subcommands.get(parent)!.join(" ");
    caseArms.push(`        ${parent}) COMPREPLY=( $(compgen -W "${children}" -- "$cur") );;`);
  }
  return [
    "# muse bash completion",
    "# Source from ~/.bashrc:  source <(muse completion bash)",
    "_muse_completions() {",
    "  local cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    `  local subs="${subs}"`,
    "  if [ \"$COMP_CWORD\" -eq 1 ]; then",
    "    COMPREPLY=( $(compgen -W \"$subs\" -- \"$cur\") )",
    "  elif [ \"$COMP_CWORD\" -eq 2 ]; then",
    "    case \"${COMP_WORDS[1]}\" in",
    ...caseArms,
    "        *) COMPREPLY=() ;;",
    "    esac",
    "  else",
    "    COMPREPLY=()",
    "  fi",
    "  return 0",
    "}",
    "complete -F _muse_completions muse",
    ""
  ].join("\n");
}

/**
 * Render the zsh completion script. `_describe` lists the verbs at
 * word 2; at word 3 a `case` on `${words[2]}` describes the typed
 * group's subcommands. Per-verb annotations stay out of scope.
 */
export function renderZshCompletion(
  commandNames: readonly string[],
  subcommands: ReadonlyMap<string, readonly string[]> = new Map()
): string {
  const lines = commandNames.map((name) => `    '${name}'`).join("\n");
  const caseArms: string[] = [];
  for (const parent of [...subcommands.keys()].sort()) {
    const children = subcommands.get(parent)!.map((name) => `'${name}'`).join(" ");
    caseArms.push(`      ${parent}) local -a sc; sc=(${children}); _describe -t commands '${parent} subcommand' sc ;;`);
  }
  return [
    "#compdef muse",
    "# muse zsh completion",
    "# Save under any directory on $fpath, e.g. ${fpath[1]}/_muse",
    "_muse() {",
    "  local -a subs",
    "  subs=(",
    lines,
    "  )",
    "  if (( CURRENT == 2 )); then",
    "    _describe -t commands 'muse command' subs",
    "  elif (( CURRENT == 3 )); then",
    "    case \"${words[2]}\" in",
    ...caseArms,
    "    esac",
    "  fi",
    "}",
    "_muse \"$@\"",
    ""
  ].join("\n");
}

export function registerCompletionCommand(program: Command, io: ProgramIO): void {
  program
    .command("completion")
    .description("Print a shell-completion script for bash or zsh")
    .argument("<shell>", "Target shell: 'bash' or 'zsh'")
    .action((shell: string) => {
      const normalized = shell.trim().toLowerCase() as SupportedShell;
      if (normalized !== "bash" && normalized !== "zsh") {
        const suggestion = closestCommandName(normalized, SUPPORTED_SHELLS);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(`muse completion: only 'bash' and 'zsh' are supported (got '${shell}')${hint}\n`);
        process.exitCode = 1;
        return;
      }
      const names = collectTopLevelCommandNames(program);
      const subcommands = collectSubcommandMap(program);
      const script = normalized === "bash"
        ? renderBashCompletion(names, subcommands)
        : renderZshCompletion(names, subcommands);
      io.stdout(script);
    });
}
