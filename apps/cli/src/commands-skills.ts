/**
 * `muse skills` — list, scaffold, and locate Muse skills.
 *
 * A skill is a `~/.muse/skills/<name>/SKILL.md` folder (claude-style): a
 * frontmatter block (name, description) plus a markdown body of
 * instructions the model follows when the request matches. The Ink chat
 * (`chat-ink.ts`) loads this directory and injects the skills so the
 * model can use them. Override the location with MUSE_SKILLS_DIR.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSkillsFromDirectory } from "@muse/skills";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export function resolveSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills");
}

/** The starter SKILL.md a fresh `muse skills add <name>` writes. */
export function buildSkillScaffold(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Use this skill when the user's request matches its purpose. Replace this",
    "body with concrete instructions for how Muse should behave — steps to",
    "follow, the tone to use, examples, and anything to avoid.",
    ""
  ].join("\n");
}

/** Reject names that would escape the skills directory. */
export function isSafeSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]*$/u.test(name) && !name.includes("..");
}

export function registerSkillsCommands(program: Command, io: ProgramIO): void {
  const skills = program.command("skills").description("List, add, and locate Muse skills (~/.muse/skills)");

  skills
    .command("list")
    .description("List installed skills")
    .action(async () => {
      const dir = resolveSkillsDir();
      const loaded = await loadSkillsFromDirectory(dir, "user").catch(() => []);
      if (loaded.length === 0) {
        io.stdout(`No skills yet. Add one with \`muse skills add <name>\` (dir: ${dir}).\n`);
        return;
      }
      io.stdout(`Skills (${loaded.length.toString()}) in ${dir}:\n`);
      for (const skill of loaded) {
        io.stdout(`  - ${skill.name} — ${skill.description}\n`);
      }
    });

  skills
    .command("path")
    .description("Print the skills directory")
    .action(() => {
      io.stdout(`${resolveSkillsDir()}\n`);
    });

  skills
    .command("add <name>")
    .description("Scaffold a new skill folder with a SKILL.md template")
    .option("--description <text>", "One-line description of the skill")
    .action(async (name: string, options: { readonly description?: string }) => {
      if (!isSafeSkillName(name)) {
        io.stderr("error: skill name may only contain letters, numbers, spaces, '-' and '_'.\n");
        process.exitCode = 1;
        return;
      }
      const dir = join(resolveSkillsDir(), name);
      const file = join(dir, "SKILL.md");
      if (await stat(file).then(() => true).catch(() => false)) {
        io.stderr(`error: a skill already exists at ${file}\n`);
        process.exitCode = 1;
        return;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, buildSkillScaffold(name, options.description?.trim() || `${name} skill`), "utf8");
      io.stdout(`Created ${file}\nEdit it, then it loads automatically in \`muse\`.\n`);
    });
}
