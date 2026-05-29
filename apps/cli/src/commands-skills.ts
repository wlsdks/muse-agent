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

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { AuthoredSkillStore, loadSkillsFromDirectory } from "@muse/skills";
import type { Command } from "commander";

import { authorSkillsFromSession } from "./chat-author-skills.js";
import type { ProgramIO } from "./program.js";

export function resolveSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills");
}

export function resolveAuthoredSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_AUTHORED_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills", "authored");
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
    .command("author")
    .description("Author reusable skills from procedural corrections you made in your last chat session")
    .option("--model <id>", "Model to author with (default the configured model)")
    .action(async (options: { readonly model?: string }) => {
      const assembly = createMuseRuntimeAssembly();
      const model = options.model ?? assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stdout("skills author needs a model provider — run `muse setup` or set MUSE_MODEL\n");
        return;
      }
      const result = await authorSkillsFromSession({
        model,
        modelProvider: assembly.modelProvider as Parameters<typeof authorSkillsFromSession>[0]["modelProvider"]
      });
      if (result.status === "authored") {
        io.stdout(`Authored ${result.skills.length.toString()} skill${result.skills.length === 1 ? "" : "s"} from your last session:\n`);
        for (const name of result.skills) {
          io.stdout(`  - ${name}\n`);
        }
        return;
      }
      io.stdout(`(nothing authored: ${result.reason})\n`);
    });

  skills
    .command("authored")
    .description("List agent-authored skills with usage dates (written by `muse skills author`)")
    .action(async () => {
      const dir = resolveAuthoredSkillsDir();
      const store = new AuthoredSkillStore({ dir });
      const authored = await store.listAuthored().catch(() => []);
      if (authored.length === 0) {
        io.stdout(`No authored skills yet. Run \`muse skills author\` after a chat session (dir: ${dir}).\n`);
        return;
      }
      io.stdout(`Authored skills (${authored.length.toString()}) in ${dir}:\n`);
      for (const skill of authored) {
        const muse = (skill.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
        const authoredAt = typeof muse.authoredAt === "string" ? muse.authoredAt.slice(0, 10) : "unknown";
        const lastUsedAt = typeof muse.lastUsedAt === "string" ? muse.lastUsedAt.slice(0, 10) : "never";
        io.stdout(`  - ${skill.name} — ${skill.description}\n`);
        io.stdout(`    authored: ${authoredAt}  last used: ${lastUsedAt}\n`);
      }
    });

  skills
    .command("curate")
    .description("Archive agent-authored skills not used within the idle window (never deletes)")
    .option("--max-idle-days <n>", "Archive authored skills idle longer than this many days", "90")
    .action(async (options: { readonly maxIdleDays?: string }) => {
      const days = Number(options.maxIdleDays ?? "90");
      if (!Number.isFinite(days) || days <= 0) {
        io.stderr("error: --max-idle-days must be a positive number.\n");
        process.exitCode = 1;
        return;
      }
      const dir = resolveAuthoredSkillsDir();
      const store = new AuthoredSkillStore({ dir });
      const archived = await store.curate(days).catch(() => [] as readonly string[]);
      if (archived.length === 0) {
        io.stdout(`No authored skills idle beyond ${days.toString()} days — nothing archived.\n`);
        return;
      }
      io.stdout(`Archived ${archived.length.toString()} stale authored skill(s) to ${join(dir, ".archive")} (not deleted):\n`);
      for (const name of archived) io.stdout(`  - ${name}\n`);
    });

  skills
    .command("consolidate")
    .description("Merge overlapping agent-authored skills into umbrellas (preview by default; --apply to do it; originals archived, never deleted)")
    .option("--threshold <n>", "Name+description similarity to cluster (0..1, default 0.5)")
    .option("--apply", "Actually merge (default: dry-run preview)")
    .option("--model <id>", "Model to merge with (default the configured model)")
    .action(async (options: { readonly threshold?: string; readonly apply?: boolean; readonly model?: string }) => {
      const threshold = options.threshold === undefined ? 0.5 : Number(options.threshold);
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
        io.stderr("error: --threshold must be a number in (0, 1].\n");
        process.exitCode = 1;
        return;
      }
      const assembly = createMuseRuntimeAssembly();
      const model = options.model ?? assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stdout("consolidate needs a model provider — run `muse setup` or set MUSE_MODEL.\n");
        return;
      }
      const { mergeSkillsIntoUmbrella } = await import("@muse/agent-core");
      const store = new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() });
      const merge = (cluster: Parameters<typeof mergeSkillsIntoUmbrella>[0]) =>
        mergeSkillsIntoUmbrella(cluster, {
          model,
          modelProvider: assembly.modelProvider as Parameters<typeof mergeSkillsIntoUmbrella>[1]["modelProvider"]
        });
      const plan = await store.consolidate(merge, { threshold, dryRun: options.apply !== true });
      if (plan.length === 0) {
        io.stdout("No authored skills cohere into an umbrella — nothing to consolidate.\n");
        return;
      }
      io.stdout(`${options.apply ? "Consolidated" : "Would consolidate"} ${plan.length.toString()} cluster(s):\n`);
      for (const entry of plan) io.stdout(`  ${entry.merged.join(" + ")}  →  ${entry.umbrella}\n`);
      if (!options.apply) io.stdout("\nRun with --apply to merge (originals archived to .archive/, never deleted).\n");
    });

  skills
    .command("archived")
    .description("List archived authored skills (from curate/consolidate) — restorable")
    .action(async () => {
      const names = await new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() }).listArchived();
      if (names.length === 0) {
        io.stdout("No archived authored skills.\n");
        return;
      }
      io.stdout(`Archived authored skills (${names.length.toString()}) — restore with \`muse skills restore <name>\`:\n`);
      for (const name of names) io.stdout(`  - ${name}\n`);
    });

  skills
    .command("restore <name>")
    .description("Restore an archived authored skill back to active (curate/consolidate rollback)")
    .action(async (name: string) => {
      const ok = await new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() }).restore(name);
      if (!ok) {
        io.stderr(`Could not restore '${name}' (not archived, or a live skill already holds that slot).\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(`Restored '${name}' to active authored skills.\n`);
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
