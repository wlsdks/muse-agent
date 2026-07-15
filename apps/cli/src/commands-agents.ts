/**
 * `muse agents` — define, list, and locate manual sub-agents.
 *
 * An agent is a `~/.muse/agents/<name>/AGENT.md` folder: frontmatter
 * (name, description) plus a markdown body that becomes the agent's
 * SYSTEM PROMPT. In the chat, `/agents` lists them and `/agent <name>`
 * switches the active one — its prompt then drives Muse's replies. This
 * is the manual counterpart to the auto sub-agent orchestration.
 * Override the location with MUSE_AGENTS_DIR.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";



import { parseSkillFile } from "@muse/skills";
import type { Command } from "commander";

import { isSafeSkillName } from "./commands-skills.js";
import type { ProgramIO } from "./program.js";
import { pathExists } from "./path-exists.js";
import { withBestEffort } from "./async-promises.js";

export interface AgentDef {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

export function resolveAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_AGENTS_DIR?.trim() || join(homedir(), ".muse", "agents");
}

/** Same naming rule as skills — no traversal, plain characters only. */
export const isSafeAgentName = isSafeSkillName;

/** The starter AGENT.md a fresh `muse agents add <name>` writes. */
export function buildAgentScaffold(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `You are ${name}.`,
    "",
    "Replace this body with the agent's system prompt — its role, how it",
    "should respond, its tone, and anything to avoid. Everything here is fed",
    "to the model as the system prompt while this agent is active.",
    ""
  ].join("\n");
}

/** Load every `<dir>/<name>/AGENT.md` as an AgentDef (fail-soft). */
export async function loadAgents(dir: string): Promise<readonly AgentDef[]> {
  let entries: readonly string[];
  try {
    const list = await readdir(dir, { withFileTypes: true });
    entries = list.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: AgentDef[] = [];
  for (const entry of entries) {
    const file = join(dir, entry, "AGENT.md");
    try {
      const info = await withBestEffort(stat(file), undefined);
      if (!info?.isFile()) continue;
      const parsed = await parseSkillFile(file, { source: "user" });
      out.push({ description: parsed.description, name: parsed.name, prompt: parsed.body.trim() });
    } catch {
      // skip a malformed AGENT.md rather than failing the whole load
    }
  }
  return out;
}

export function registerAgentsCommands(program: Command, io: ProgramIO): void {
  const agents = program.command("agents").description("Define, list, and locate manual sub-agents (~/.muse/agents)");

  agents
    .command("list")
    .description("List defined agents")
    .action(async () => {
      const dir = resolveAgentsDir();
      const defs = await loadAgents(dir);
      if (defs.length === 0) {
        io.stdout(`No agents yet. Define one with \`muse agents add <name>\` (dir: ${dir}).\n`);
        return;
      }
      io.stdout(`Agents (${defs.length.toString()}) in ${dir}:\n`);
      for (const def of defs) io.stdout(`  - ${def.name} — ${def.description}\n`);
    });

  agents
    .command("path")
    .description("Print the agents directory")
    .action(() => io.stdout(`${resolveAgentsDir()}\n`));

  agents
    .command("show <name>")
    .description("Print one agent's prompt")
    .action(async (name: string) => {
      const def = (await loadAgents(resolveAgentsDir())).find((a) => a.name === name);
      if (!def) {
        io.stderr(`error: no agent named '${name}'\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(`# ${def.name} — ${def.description}\n\n${def.prompt}\n`);
    });

  agents
    .command("add <name>")
    .description("Scaffold a new agent folder with an AGENT.md template")
    .option("--description <text>", "One-line description of the agent")
    .action(async (name: string, options: { readonly description?: string }) => {
      if (!isSafeAgentName(name)) {
        io.stderr("error: agent name may only contain letters, numbers, spaces, '-' and '_'.\n");
        process.exitCode = 1;
        return;
      }
      const file = join(resolveAgentsDir(), name, "AGENT.md");
      if (await pathExists(file)) {
        io.stderr(`error: an agent already exists at ${file}\n`);
        process.exitCode = 1;
        return;
      }
      await mkdir(join(resolveAgentsDir(), name), { recursive: true });
      await writeFile(file, buildAgentScaffold(name, options.description?.trim() || `${name} agent`), "utf8");
      io.stdout(`Created ${file}\nEdit its body (the system prompt), then pick it in chat with \`/agent ${name}\`.\n`);
    });
}
