/**
 * `muse reflections [refresh]` — Muse's grounded "dreaming". `refresh` runs a
 * reflection pass over your recent episodes (synthesising higher-level insights
 * about you) and stores the GROUNDED ones; the bare command lists them with the
 * real episodes each insight came from. Every insight cites its sources — Muse
 * dreams about your life but can't make a thing up (docs/strategy/the-edge.md).
 */

import { randomUUID } from "node:crypto";

import { buildGroundingReverifyPrompt, filterReflectionsAgainstStore, parseGroundingReverifyJson, REVERIFY_RESPONSE_FORMAT, REVERIFY_SYSTEM_PROMPT, synthesizeReflections, type GroundingReverify, type Reflection, type ReflectionInput } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";
import { createGateEmbedder, createMuseRuntimeAssembly, resolveEpisodesFile, resolveReflectionsFile as sharedResolveReflectionsFile } from "@muse/autoconfigure";
import { addReflections, listReflections, readEpisodes, readReflections, type NewReflection, type StoredReflection } from "@muse/stores";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export function resolveReflectionsFile(env: Record<string, string | undefined> = process.env): string {
  return sharedResolveReflectionsFile(env);
}

export interface ReflectionPassOptions {
  readonly reflectionsFile: string;
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly now?: () => number;
  readonly genId?: () => string;
  /** Embedder for semantic near-duplicate collapse of synthesised insights. */
  readonly embed?: (text: string) => Promise<readonly number[]>;
}

/**
 * Synthesise grounded reflections from the given episode inputs and persist the
 * new ones (deduped). Returns how many were added. Shared by `muse reflections
 * refresh` and the daemon idle pass.
 */
export async function runReflectionPass(inputs: readonly ReflectionInput[], options: ReflectionPassOptions): Promise<number> {
  const usable = inputs.filter((i) => i.id.length > 0 && i.text.trim().length > 0);
  if (usable.length < 2) return 0;
  // RGV re-verification (offline path): each synthesised insight is re-checked
  // against the TEXT of its cited episodes by a one-shot local judge, so a
  // confabulated "dream" that cites real-but-unrelated sources is dropped.
  const reverify: GroundingReverify = async ({ answer, evidence, query }) => {
    const judged = await options.modelProvider.generate({
      maxOutputTokens: 24,
      responseFormat: REVERIFY_RESPONSE_FORMAT,
      messages: [
        { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
        { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
      ],
      model: options.model,
      temperature: 0
    });
    return parseGroundingReverifyJson(judged.output ?? "");
  };
  const fresh = await synthesizeReflections(usable, {
    model: options.model,
    modelProvider: options.modelProvider,
    reverify,
    ...(options.embed ? { embed: options.embed } : {})
  });
  // Cross-tick NOOP dedup (Mem0): drop a fresh insight semantically equivalent to
  // one ALREADY in the store, which the store's lexical dedup misses on paraphrase.
  const toStore = options.embed && fresh.length > 0
    ? await filterReflectionsAgainstStore(
        fresh,
        (await readReflections(options.reflectionsFile)).map((r) => r.insight),
        options.embed
      )
    : fresh;
  return addReflections(
    options.reflectionsFile,
    reflectionsToStore(toStore, options.now?.() ?? Date.now(), options.genId ?? (() => randomUUID()))
  );
}

/** True when a reflection pass is due (never run, or `intervalMs` has elapsed). */
export function shouldRunReflection(lastRunMs: number | undefined, nowMs: number, intervalMs: number): boolean {
  if (lastRunMs === undefined) return true;
  return nowMs - lastRunMs >= intervalMs;
}

/** Default idle reflection cadence — 6h (the daemon "dreams" a few times a day, not every tick). */
export const DEFAULT_REFLECTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface ReflectionSource {
  readonly startedAt: string;
  readonly summary: string;
}

/**
 * Render reflections. When `sources` is given (id → episode), each cited source
 * is shown as a FOLLOWABLE line — its date + a summary snippet — so the user can
 * verify the insight against the real moment, fulfilling the edge's "shows its
 * work, verifiable" promise. Without it, falls back to the bare source ids.
 */
export function renderReflections(entries: readonly StoredReflection[], sources?: ReadonlyMap<string, ReflectionSource>): string {
  const sorted = listReflections(entries);
  if (sorted.length === 0) {
    return "No reflections yet. Run `muse reflections refresh` to synthesise insights from your recent sessions.";
  }
  const lines = [`What Muse has noticed about you (${sorted.length.toString()}):\n`];
  for (const r of sorted) {
    lines.push(`  • ${r.insight}`);
    if (sources) {
      lines.push("    grounded in:");
      for (const id of r.sourceIds) {
        const ep = sources.get(id);
        lines.push(ep
          ? `      · [${ep.startedAt.slice(0, 10)}] ${ep.summary.replace(/\s+/gu, " ").trim().slice(0, 70)}`
          : `      · ${id}`);
      }
    } else {
      lines.push(`    — from ${r.sourceIds.join(", ")}`);
    }
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
      const entries = await readReflections(resolveReflectionsFile());
      if (options.json) {
        io.stdout(`${JSON.stringify(listReflections(entries), null, 2)}\n`);
        return;
      }
      // Join the cited episode ids to their date + summary so the grounding is
      // followable (verifiable), not an opaque id. Fail-soft: no episodes → ids.
      let sources: Map<string, ReflectionSource> | undefined;
      try {
        const episodes = await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>));
        sources = new Map(episodes.map((ep) => [ep.id, { startedAt: ep.startedAt, summary: ep.summary }]));
      } catch { /* no episodes — fall back to bare ids */ }
      io.stdout(`${renderReflections(entries, sources)}\n`);
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
      const inputs = episodes.map((ep) => ({ id: ep.id, text: ep.summary }));
      if (inputs.filter((i) => i.text.trim().length > 0).length < 2) {
        io.stdout("Not enough past sessions to reflect over yet — keep using Muse and try again.\n");
        return;
      }
      const added = await runReflectionPass(inputs, { model, modelProvider: assembly.modelProvider, reflectionsFile: resolveReflectionsFile(), embed: createGateEmbedder(process.env) });
      io.stdout(added > 0
        ? `🌙 Added ${added.toString()} new reflection(s). See them: muse reflections\n`
        : "No new grounded reflections this pass (nothing recurring across your sessions, or already noted).\n");
    });
}
