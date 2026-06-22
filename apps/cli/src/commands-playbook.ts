/**
 * `muse playbook` — the user entry point to the learned-strategy playbook
 * (ACE, arXiv 2510.04618). Local mode over the shared `~/.muse/playbook.json`,
 * the same file `buildPlaybookProvider` adapts into the agent runtime, so a
 * CLI-added strategy surfaces as `[Learned Strategies]` on the next agent run
 * with no API server required.
 */

import { randomUUID } from "node:crypto";

import { clusterByTextSimilarity, mergePlaybookStrategies, PLAYBOOK_AVOID_BELOW, strategyTextSimilarity, validateMergeCoverage } from "@muse/agent-core";
import { createGateEmbedder, createMuseRuntimeAssembly, resolveLearningPauseFile, resolvePlaybookFile, resolveSuppressedLessonsFile } from "@muse/autoconfigure";
import { adjustPlaybookReward, decryptPlaybookAtRest, encryptPlaybookAtRest, isPlaybookEncrypted, queryPlaybook, recordPlaybookStrategy, recordSuppressedLesson, removePlaybookStrategy, setLearningPaused, type PlaybookEntry } from "@muse/stores";
import type { Command } from "commander";

import { distillSessionCorrections } from "./chat-distill-corrections.js";
import { consolidatePlaybook } from "./playbook-consolidate.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

function playbookFile(): string {
  return resolvePlaybookFile(process.env as Record<string, string | undefined>);
}

function suppressedLessonsFile(): string {
  return resolveSuppressedLessonsFile(process.env as Record<string, string | undefined>);
}

function learningPauseFile(): string {
  return resolveLearningPauseFile(process.env as Record<string, string | undefined>);
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
        const avoided = reward <= PLAYBOOK_AVOID_BELOW ? " · avoided (not injected)" : "";
        const rewardTag = reward === 0 ? "" : ` ⟨reward ${reward > 0 ? "+" : ""}${reward.toString()}${avoided}⟩`;
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
    .command("undo")
    .description("Remove a strategy AND teach Muse not to re-learn it — unlike `remove`, the idle distiller won't bring this lesson back from a similar future correction")
    .argument("<id>", "Strategy id (prefix from `playbook list`)")
    .action(async (id: string) => {
      const all = await queryPlaybook(playbookFile());
      const match = all.find((e) => e.id === id) ?? all.find((e) => e.id.startsWith(id));
      if (!match) {
        io.stdout(`(no strategy matches "${id}")\n`);
        return;
      }
      await removePlaybookStrategy(playbookFile(), match.id);
      await recordSuppressedLesson(suppressedLessonsFile(), {
        createdAt: new Date().toISOString(),
        id: match.id,
        text: match.text,
        userId: match.userId,
        // The correction it was distilled from (provenance) is the stable signal
        // the idle distiller matches future corrections against.
        ...(match.source ? { source: match.source } : {})
      });
      io.stdout(match.source
        ? `Undid strategy [${match.id.slice(0, 12)}] — Muse won't re-learn this from a similar correction.\n`
        : `Undid strategy [${match.id.slice(0, 12)}].\n`);
    });

  playbook
    .command("pause")
    .description("Pause ALL background self-learning — Muse stops distilling AND enqueueing corrections until you `playbook resume`")
    .action(async () => {
      await setLearningPaused(learningPauseFile(), true, new Date().toISOString());
      io.stdout("⏸ Background learning paused — Muse won't learn anything new until you run `muse playbook resume`.\n");
    });

  playbook
    .command("resume")
    .description("Resume background self-learning after `playbook pause`")
    .action(async () => {
      await setLearningPaused(learningPauseFile(), false);
      io.stdout("▶ Background learning resumed.\n");
    });

  playbook
    .command("reward")
    .description("Reinforce a strategy's learned reward — `--down` to penalise instead — e.g. `muse playbook reward ab12 2`")
    .argument("<id>", "Strategy id (prefix from `playbook list`)")
    .argument("[amount]", "Positive integer to add (default 1)", "1")
    .option("--down", "Penalise (subtract the amount) instead of reinforce")
    .action(async (id: string, amountStr: string, options: { readonly down?: boolean }) => {
      const amount = Number(amountStr);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error("playbook reward <amount> must be a positive integer");
      }
      const all = await queryPlaybook(playbookFile());
      const match = all.find((e) => e.id === id) ?? all.find((e) => e.id.startsWith(id));
      if (!match) {
        io.stdout(`(no strategy matches "${id}")\n`);
        return;
      }
      const reward = await adjustPlaybookReward(playbookFile(), match.id, options.down ? -amount : amount);
      io.stdout(reward === undefined
        ? `(could not adjust [${match.id.slice(0, 12)}])\n`
        : `[${match.id.slice(0, 12)}] reward → ${reward > 0 ? "+" : ""}${reward.toString()}\n`);
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
      const modelProvider = assembly.modelProvider as Parameters<typeof mergePlaybookStrategies>[1]["modelProvider"];
      const embed = createGateEmbedder(process.env);
      const { merged, rejected } = await consolidatePlaybook(clusters, {
        apply: options.apply === true,
        log: (line) => io.stdout(`${line}\n`),
        merge: (texts) => mergePlaybookStrategies(texts, { model, modelProvider }),
        record: async (text, tag) => {
          await recordPlaybookStrategy(playbookFile(), {
            id: `pb_${randomUUID()}`,
            userId,
            text,
            ...(tag ? { tag } : {}),
            createdAt: new Date().toISOString()
          });
        },
        remove: async (id) => { await removePlaybookStrategy(playbookFile(), id); },
        // SkillOpt held-out gate: a merged strategy commits only if it still
        // semantically covers every original (local nomic embedder); a
        // coverage-losing merge is rejected and the originals are kept.
        validate: async (originals, mergedText) => {
          // label = full strategy text (not a 40-char slice) so verdict.lost feeds
          // the steered retry the COMPLETE dropped strategy, not a mid-word fragment.
          const verdict = await validateMergeCoverage(
            originals.map((t) => ({ label: t, text: t })),
            { label: mergedText.slice(0, 40), text: mergedText },
            { embed }
          );
          return { accept: verdict.accept, lost: verdict.lost, reason: verdict.reason };
        }
      });
      if (merged === 0) {
        io.stdout(rejected > 0
          ? `Clusters found but ${rejected.toString()} merge(s) rejected by the held-out gate.\n`
          : "Clusters found but none cohered into a merge.\n");
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

  playbook
    .command("encrypt")
    .description("Encrypt the learned-strategy bank at rest (AES-256-GCM; key = MUSE_MEMORY_KEY or per-host)")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = playbookFile();
      const result = await encryptPlaybookAtRest(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted: true, file, ...result }, null, 2)}\n`);
        return;
      }
      if (result.alreadyEncrypted) {
        io.stdout(`Learned bank is already encrypted at rest (${file}).\n`);
        return;
      }
      io.stdout(
        `Encrypted learned bank at rest: ${file}\n` +
        (result.backupPath
          ? `Plaintext backup saved: ${result.backupPath}\n` +
            `  ⚠ This backup is CLEARTEXT — it holds everything Muse has learned about you, unencrypted.\n` +
            `  Delete it once you've confirmed 'muse learned' still works with your key.\n`
          : "") +
        `Set MUSE_MEMORY_KEY to a stable secret so the key survives a host/user change.\n`
      );
    });

  playbook
    .command("decrypt")
    .description("Revert the learned-strategy bank to plaintext at rest")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = playbookFile();
      const result = await decryptPlaybookAtRest(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted: false, file, ...result }, null, 2)}\n`);
        return;
      }
      io.stdout(
        result.alreadyPlaintext
          ? `Learned bank is already plaintext at rest (${file}).\n`
          : `Reverted learned bank to plaintext at rest: ${file}\n`
      );
    });

  playbook
    .command("encryption-status")
    .description("Report whether the learned bank is encrypted at rest (no key needed)")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = playbookFile();
      const encrypted = await isPlaybookEncrypted(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted, file }, null, 2)}\n`);
        return;
      }
      io.stdout(`Learned bank at rest: ${encrypted ? "ENCRYPTED" : "plaintext"} (${file})\n`);
    });
}
