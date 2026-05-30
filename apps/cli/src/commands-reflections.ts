/**
 * `muse reflections [refresh]` — Muse's grounded "dreaming". `refresh` runs a
 * reflection pass over your recent episodes (synthesising higher-level insights
 * about you) and stores the GROUNDED ones; the bare command lists them with the
 * real episodes each insight came from. Every insight cites its sources — Muse
 * dreams about your life but can't make a thing up (docs/strategy/the-edge.md).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { synthesizeReflections, type Reflection } from "@muse/agent-core";
import { createMuseRuntimeAssembly, resolveEpisodesFile } from "@muse/autoconfigure";
import {
  addReflections,
  listReflections,
  readEpisodes,
  readReflections,
  type NewReflection,
  type StoredReflection
} from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function reflectionsFile(): string {
  return process.env.MUSE_REFLECTIONS_FILE?.trim() || join(homedir(), ".muse", "reflections.json");
}

export function renderReflections(entries: readonly StoredReflection[]): string {
  const sorted = listReflections(entries);
  if (sorted.length === 0) {
    return "No reflections yet. Run `muse reflections refresh` to synthesise insights from your recent sessions.";
  }
  const lines = [`What Muse has noticed about you (${sorted.length.toString()}):\n`];
  for (const r of sorted) {
    lines.push(`  • ${r.insight}`);
    lines.push(`    — from ${r.sourceIds.join(", ")}`);
  }
  return lines.join("\n");
}

/** Map freshly synthesised reflections to store rows. Pure (clock/id injected). */
export function reflectionsToStore(reflections: readonly Reflection[], nowMs: number, genId: () => string): NewReflection[] {
  return reflections.map((r) => ({
    createdAtMs: nowMs,
    id: genId(),
    insight: r.insight,
    sourceIds: r.sourceIds,
    supportCount: r.supportCount
  }));
}

export function registerReflectionsCommand(program: Command, io: ProgramIO): void {
  const reflections = program
    .command("reflections")
    .description("Grounded insights Muse has formed about you from past sessions (each cites its sources)")
    .option("--json", "Print the raw reflections")
    .action(async (options: { readonly json?: boolean }) => {
      const entries = await readReflections(reflectionsFile());
      if (options.json) {
        io.stdout(`${JSON.stringify(listReflections(entries), null, 2)}\n`);
        return;
      }
      io.stdout(`${renderReflections(entries)}\n`);
    });

  reflections
    .command("refresh")
    .description("Synthesise new grounded reflections from your recent episodes")
    .option("--limit <n>", "How many recent episodes to reflect over (default 30)", "30")
    .action(async (options: { readonly limit: string }) => {
      const assembly = createMuseRuntimeAssembly();
      const model = assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stderr("muse reflections refresh: needs a configured local model (set MUSE_MODEL).\n");
        process.exitCode = 1;
        return;
      }
      const limit = Math.max(2, Math.trunc(Number.parseInt(options.limit, 10) || 30));
      const episodes = (await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>))).slice(-limit);
      const inputs = episodes
        .map((e) => ({ id: e.id, text: e.summary }))
        .filter((e) => e.id.length > 0 && e.text.trim().length > 0);
      if (inputs.length < 2) {
        io.stdout("Not enough past sessions to reflect over yet — keep using Muse and try again.\n");
        return;
      }
      const fresh = await synthesizeReflections(inputs, { model, modelProvider: assembly.modelProvider });
      const added = await addReflections(reflectionsFile(), reflectionsToStore(fresh, Date.now(), () => randomUUID()));
      io.stdout(added > 0
        ? `🌙 Added ${added.toString()} new reflection(s). See them: muse reflections\n`
        : "No new grounded reflections this pass (nothing recurring across your sessions, or already noted).\n");
    });
}
