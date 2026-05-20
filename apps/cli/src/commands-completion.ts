/**
 * Goal 066 — `muse completion <shell>` emits a static shell
 * completion script for bash / zsh. The script knows the
 * top-level subcommand names; subcommand-specific completions
 * (flags, choice values) are intentionally out of scope — the
 * vast majority of value comes from "tab-complete the verb",
 * and richer completions need shell-specific deeper integration
 * (`_arguments` for zsh, `complete -W` for bash) which adds
 * significant code with diminishing returns.
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
 * Goal 066 — render the bash completion script for the given
 * command names. Pure function so the unit test can assert
 * the structural shape without running through the CLI.
 */
export function renderBashCompletion(commandNames: readonly string[]): string {
  const subs = commandNames.join(" ");
  return [
    "# muse bash completion",
    "# Source from ~/.bashrc:  source <(muse completion bash)",
    "_muse_completions() {",
    "  local cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    `  local subs="${subs}"`,
    "  if [ \"$COMP_CWORD\" -eq 1 ]; then",
    "    COMPREPLY=( $(compgen -W \"$subs\" -- \"$cur\") )",
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
 * Goal 066 — render the zsh completion script. Uses `_describe`
 * so the user sees the verb list with no per-verb annotations
 * (kept intentionally minimal — see header comment).
 */
export function renderZshCompletion(commandNames: readonly string[]): string {
  const lines = commandNames.map((name) => `    '${name}'`).join("\n");
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
      const names = collectTopLevelCommandNames(program).filter((name) => name !== "completion");
      const script = normalized === "bash"
        ? renderBashCompletion(names)
        : renderZshCompletion(names);
      io.stdout(script);
    });
}
