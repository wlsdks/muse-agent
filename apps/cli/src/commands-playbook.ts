/**
 * `muse playbook` — the user entry point to the learned-strategy playbook
 * (ACE, arXiv 2510.04618). Local mode over the shared `~/.muse/playbook.json`,
 * the same file `buildPlaybookProvider` adapts into the agent runtime, so a
 * CLI-added strategy surfaces as `[Learned Strategies]` on the next agent run
 * with no API server required.
 */

import { randomUUID } from "node:crypto";

import { clusterByTextSimilarity, mergePlaybookStrategies, strategyTextSimilarity } from "@muse/agent-core";
import { createMuseRuntimeAssembly, resolvePlaybookFile } from "@muse/autoconfigure";
import { queryPlaybook, recordPlaybookStrategy, removePlaybookStrategy, type PlaybookEntry } from "@muse/mcp";
import type { Command } from "commander";

import { distillSessionCorrections } from "./chat-distill-corrections.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

function playbookFile(): string {
  return resolvePlaybookFile(process.env as Record<string, string | undefined>);
}

export function registerPlaybookCommands(program: Command, io: ProgramIO): void {
  const playbook = program.command("playbook").description("Learned strategies the agent applies from past feedback (ACE)");

  playbook
    .command("add")
    .description("Record a strategy, e.g. `muse playbook add \"keep work emails under 4 sentences\" --tag email`")
    .argument("<text...>", "The strategy (joined by spaces)")
    .option("--tag <tag>", "Optional task-class tag (e.g. email, scheduling)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .action(async (parts: string[], options: { readonly tag?: string; readonly user?: string }) => {
      const text = parts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("playbook add requires a non-empty strategy");
      }
      const userId = resolveDefaultUserKey({ override: options.user });
      await recordPlaybookStrategy(playbookFile(), {
        id: `pb_${randomUUID()}`,
        userId,
        text,
        ...(options.tag && options.tag.trim().length > 0 ? { tag: options.tag.trim() } : {}),
        createdAt: new Date().toISOString()
      });
      io.stdout(`Recorded strategy (user=${userId})\n`);
    });

  playbook
    .command("list")
    .description("List learned strategies")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--json", "Print the raw entries")
    .action(async (options: { readonly user?: string; readonly json?: boolean }) => {
      const userId = resolveDefaultUserKey({ override: options.user });
      const entries = await queryPlaybook(playbookFile(), userId);
      if (options.json) {
        io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        io.stdout("(no learned strategies yet)\n");
        return;
      }
      for (const e of entries) {
        const reward = typeof e.reward === "number" && Number.isFinite(e.reward) ? e.reward : 0;
        const rewardTag = reward === 0 ? "" : ` ⟨reward ${reward > 0 ? "+" : ""}${reward.toString()}⟩`;
        io.stdout(`  [${e.id.slice(0, 12)}]${e.tag ? ` (${e.tag})` : ""}${rewardTag} ${e.text}\n`);
      }
    });

  playbook
    .command("remove")
    .description("Remove a strategy by id (prefix from `playbook list`)")
    .argument("<id>", "Strategy id")
    .action(async (id: string) => {
      const all = await queryPlaybook(playbookFile());
      const match = all.find((e) => e.id === id) ?? all.find((e) => e.id.startsWith(id));
      if (!match) {
        io.stdout(`(no strategy matches "${id}")\n`);
        return;
      }
      await removePlaybookStrategy(playbookFile(), match.id);
      io.stdout(`Removed strategy [${match.id.slice(0, 12)}]\n`);
    });

  playbook
    .command("consolidate")
    .description("Merge near-duplicate learned strategies into one (preview by default; --apply to do it)")
    .option("--threshold <n>", "Strategy similarity to cluster (0..1, default 0.6)")
    .option("--apply", "Actually merge (default: dry-run preview)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--model <id>", "Model to merge with (default the configured model)")
    .action(async (options: { readonly threshold?: string; readonly apply?: boolean; readonly user?: string; readonly model?: string }) => {
      const threshold = options.threshold === undefined ? 0.6 : Number(options.threshold);
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
        throw new Error("--threshold must be a number in (0, 1]");
      }
      const userId = resolveDefaultUserKey({ override: options.user });
      const assembly = createMuseRuntimeAssembly();
      const model = options.model ?? assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stdout("consolidate needs a model provider — run `muse setup` or set MUSE_MODEL.\n");
        return;
      }
      const entries = await queryPlaybook(playbookFile(), userId);
      const clusters = clusterByTextSimilarity(entries, (e: PlaybookEntry) => e.text, strategyTextSimilarity, threshold).filter((c) => c.length >= 2);
      if (clusters.length === 0) {
        io.stdout("No near-duplicate strategies to consolidate.\n");
        return;
      }
      let merged = 0;
      for (const cluster of clusters) {
        const mergedText = await mergePlaybookStrategies(
          cluster.map((e) => e.text),
          { model, modelProvider: assembly.modelProvider as Parameters<typeof mergePlaybookStrategies>[1]["modelProvider"] }
        );
        if (!mergedText) continue; // genuinely distinct — leave them
        merged += 1;
        if (options.apply) {
          await recordPlaybookStrategy(playbookFile(), {
            id: `pb_${randomUUID()}`,
            userId,
            text: mergedText,
            ...(cluster[0]!.tag ? { tag: cluster[0]!.tag } : {}),
            createdAt: new Date().toISOString()
          });
          for (const e of cluster) await removePlaybookStrategy(playbookFile(), e.id);
        }
        io.stdout(`  ${options.apply ? "merged" : "would merge"} ${cluster.length.toString()} → "${mergedText}"\n`);
      }
      if (merged === 0) {
        io.stdout("Clusters found but none cohered into a merge.\n");
        return;
      }
      if (!options.apply) io.stdout("\nRun with --apply to merge (originals removed, merged strategy recorded).\n");
    });

  playbook
    .command("distill")
    .description("Learn strategies from corrections you made in your last chat session (ReasoningBank)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--model <id>", "Model to distill with (default the configured model)")
    .action(async (options: { readonly user?: string; readonly model?: string }) => {
      const userId = resolveDefaultUserKey({ override: options.user });
      const assembly = createMuseRuntimeAssembly();
      const model = options.model ?? assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stdout("distill needs a model provider — run `muse setup` or set MUSE_MODEL\n");
        return;
      }
      const result = await distillSessionCorrections({
        model,
        modelProvider: assembly.modelProvider as Parameters<typeof distillSessionCorrections>[0]["modelProvider"],
        userId
      });
      if (result.reinforced.length > 0) {
        io.stdout(`Reinforced ${result.reinforced.length.toString()} strateg${result.reinforced.length === 1 ? "y" : "ies"} you approved (they rise in ranking):\n`);
        for (const r of result.reinforced) {
          io.stdout(`  ↑ (reward ${r.reward > 0 ? "+" : ""}${r.reward.toString()}) ${r.text}\n`);
        }
      }
      if (result.decayed.length > 0) {
        io.stdout(`Decayed ${result.decayed.length.toString()} strateg${result.decayed.length === 1 ? "y" : "ies"} a correction implicated (they sink in ranking):\n`);
        for (const d of result.decayed) {
          io.stdout(`  ↓ (reward ${d.reward > 0 ? "+" : ""}${d.reward.toString()}) ${d.text}\n`);
        }
      }
      if (result.status === "recorded") {
        io.stdout(`Learned ${result.strategies.length.toString()} strateg${result.strategies.length === 1 ? "y" : "ies"} from your last session:\n`);
        for (const strategy of result.strategies) {
          io.stdout(`  - ${strategy.text}${strategy.tag ? ` (${strategy.tag})` : ""}\n`);
        }
        return;
      }
      io.stdout(`(nothing learned: ${result.reason})\n`);
    });
}
