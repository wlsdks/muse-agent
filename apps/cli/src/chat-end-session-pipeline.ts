/**
 * End-of-session distillation sequence: after the Ink chat unmounts, capture
 * the episode and run the playbook / skill / check-in / preference distill
 * steps. Playbook distillation and skill authoring are ON BY DEFAULT (Muse
 * "learns you, not the world" out of the box); the rest (idle-learning,
 * check-in autoscan, preference autoinfer, skill consolidation) stay opt-in.
 * Split out of runChatInk so the runtime wiring stays focused; every step is
 * fail-soft so a flaky model never blocks exit.
 */

import { parseBoolean } from "@muse/autoconfigure";



import { resolveSkillRewardsFile } from "./commands-skills.js";
import { withBestEffort } from "./async-promises.js";

type GenerateCapableProvider = { readonly generate: unknown };
type UmbrellaConsolidation = { readonly umbrella: string; readonly merged: readonly string[] };
type SessionPreferenceInferenceResult = { readonly added: readonly string[]; readonly status: "no-model" };

const noModelPreferences = (): SessionPreferenceInferenceResult => ({ added: [], status: "no-model" });

export async function runEndOfSessionPipeline(args: {
  readonly modelProvider: unknown;
  readonly model: string;
  readonly userId: string;
  readonly sessionUntrusted: boolean;
}): Promise<void> {
  const { modelProvider, model, userId, sessionUntrusted } = args;

  // End-of-session episode: summarise the just-finished conversation (turns
  // since the boundary written at boot) into ~/.muse/episodes.json so /recall
  // and the launch recap keep growing from interactive use. Opt-in
  // (MUSE_EPISODIC_MEMORY_ENABLED, checked inside) + fail-soft, so a flaky
  // model or filesystem never blocks exit. Needs a generate-capable provider.
  if (!(modelProvider && "generate" in (modelProvider as GenerateCapableProvider))) return;

  const { captureEndOfSessionEpisode } = await import("./chat-end-session.js");
  await withBestEffort(
    captureEndOfSessionEpisode({
      model,
      modelProvider: modelProvider as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"],
      userId,
      // Mark the episode trusted:false when this session ever grounded on
      // untrusted-only sources (episode-laundering defense, MemoryGraft).
      untrustedSession: sessionUntrusted
    }),
    undefined
  );


  // End-of-session auto-distillation: turn any correction the user made this
  // session into a generalised [Learned Strategies] entry (ReasoningBank,
  // arXiv 2509.25140). The playbook branch below is ON BY DEFAULT (Muse
  // "learns you" out of the box); idle-learning stays opt-in. Fail-soft so a
  // flaky model never blocks exit.
  if (parseBoolean(process.env.MUSE_IDLE_LEARNING_ENABLED, false)) {
    // Idle self-learning (B1): ENQUEUE this session's corrections for the
    // Sleep daemon to distill later behind the brakes — no exit-time LLM
    // call, no manual step. Mutually exclusive with MUSE_PLAYBOOK_DISTILL.
    const { enqueueSessionCorrections } = await import("./chat-enqueue-corrections.js");
    await withBestEffort(enqueueSessionCorrections({ userId }), undefined);
  } else if (parseBoolean(process.env.MUSE_PLAYBOOK_DISTILL_ENABLED, true)) {
    const { distillSessionCorrections, sessionCorrectionTexts } = await import("./chat-distill-corrections.js");
    const result = await withBestEffort(
      distillSessionCorrections({
        model,
        modelProvider: modelProvider as Parameters<typeof distillSessionCorrections>[0]["modelProvider"],
        userId
      }),
      undefined
    );
    if (result?.status === "recorded") {
      for (const s of result.strategies) {
        process.stderr.write(`💾 Learned strategy: ${s.text}\n`);
      }
    }

    // Drain the lessons taught on the surfaces that have no session of their own.
    //
    // The capture hook queues a correction wherever it happens — `muse ask`, the
    // web app, Telegram, any API caller. Until now the ONLY thing that emptied that
    // queue was the self-learn daemon tick, and `muse daemon` never auto-starts, so
    // on a default install those lessons sat in the queue until the 30-day pruner
    // deleted them unread. Chat is the one place a model and an embedder are already
    // wired and the user is done waiting, so it is where the backlog gets learned.
    //
    // The skip is what keeps this honest: THIS session's own corrections are handled
    // above by the turn scan, and distilling them again here would bump their
    // observation count as if the user had taught the same thing twice.
    const { distillQueuedCorrections, resolveLearningPauseFile, resolvePlaybookFile } = await import("@muse/autoconfigure");
    const { resolveLearnQueueFile } = await import("@muse/stores");
    const sessionSaid = await withBestEffort(sessionCorrectionTexts(userId), new Set<string>());
    const drained = await withBestEffort(
      distillQueuedCorrections({
        model,
        modelProvider: modelProvider as Parameters<typeof distillQueuedCorrections>[0]["modelProvider"],
        pauseFile: resolveLearningPauseFile(process.env),
        playbookFile: resolvePlaybookFile(process.env),
        queueFile: resolveLearnQueueFile(process.env),
        skipCorrection: (correction) => sessionSaid.has(correction.trim())
      }),
      0
    );
    if (drained > 0) {
      process.stderr.write(`💾 Learned ${drained} lesson(s) you taught me elsewhere.\n`);
    }
  }

  // End-of-session skill authoring: turn a procedural correction into a
  // reusable, execute-gated SKILL.md (picked up next session). On by
  // default (Muse "learns you" out of the box); fail-soft so a flaky model
  // never blocks exit.
  if (parseBoolean(process.env.MUSE_SKILL_AUTHOR_ENABLED, true)) {
    const { authorSkillsFromSession, applySkillRewardsFromSession } = await import("./chat-author-skills.js");
    const result = await withBestEffort(
      authorSkillsFromSession({
        model,
        modelProvider: modelProvider as Parameters<typeof authorSkillsFromSession>[0]["modelProvider"]
      }),
      undefined
    );
    if (result?.status === "authored") {
      for (const name of result.skills) {
        process.stderr.write(`💾 Learned skill: ${name}\n`);
      }
    }
    // RL over skills: decay the skill that applied to a corrected request,
    // reinforce one for an approved request (deterministic + fail-soft).
    const reward = await withBestEffort(
      applySkillRewardsFromSession({
        rewardsFile: resolveSkillRewardsFile(process.env)
      }),
      undefined
    );
    for (const d of reward?.decayed ?? []) process.stderr.write(`↓ skill reward: ${d.name} (${d.reward.toString()})\n`);
    for (const r of reward?.reinforced ?? []) process.stderr.write(`↑ skill reward: ${r.name} (+${r.reward.toString()})\n`);
  }

  // End-of-session curator: fold overlapping authored skills into umbrellas
  // (originals archived, never deleted; restorable via `muse skills
  // restore`). Opt-in + fail-soft so a flaky model never blocks exit.
  if (parseBoolean(process.env.MUSE_SKILL_CONSOLIDATE_ENABLED, false)) {
    const { AuthoredSkillStore } = await import("@muse/skills");
    const { resolveAuthoredSkillsDir } = await import("./commands-skills.js");
    const { mergeSkillsIntoUmbrella, validateUmbrellaCoverage } = await import("@muse/agent-core");
    const { createGateEmbedder } = await import("@muse/autoconfigure");
    const store = new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() });
    // SkillOpt held-out gate, same as the daemon: a coverage-losing umbrella is
    // rejected (originals kept), never committed unverified on session end.
    const gateEmbed = createGateEmbedder(process.env);
    const merged = await withBestEffort(
      store.consolidate(
        (cluster) => mergeSkillsIntoUmbrella(cluster, {
          model,
          modelProvider: modelProvider as Parameters<typeof mergeSkillsIntoUmbrella>[1]["modelProvider"]
        }),
        {
          validate: (cluster, umbrella) => validateUmbrellaCoverage(cluster, umbrella, { embed: gateEmbed }).then((v) => v.accept)
        }
      ),
      [] as readonly UmbrellaConsolidation[]
    );
    for (const m of merged) {
      process.stderr.write(`🧹 Consolidated ${m.merged.length.toString()} skills → ${m.umbrella}\n`);
    }
  }

  // End-of-session commitment check-in auto-scan: detect open-loops the user
  // voiced this session and schedule due-windowed check-ins the daemon
  // delivers — so Muse speaks first WITHOUT a manual `muse checkins scan`.
  // Opt-in + fail-soft. Deterministic (no model).
  if (parseBoolean(process.env.MUSE_CHECKINS_AUTOSCAN_ENABLED, false)) {
    const { scanSessionCheckins } = await import("./commands-checkins.js");
    const scheduled = await withBestEffort(scanSessionCheckins(), []);
    for (const c of scheduled) {
      process.stderr.write(`📌 Check-in scheduled: ${c.question}\n`);
    }
  }

  // End-of-session preference auto-infer: learn stable preferences from the
  // corrections the user made this session and fold them into the typed user
  // model — so Muse learns WITHOUT a manual `muse user model infer`.
  // Opt-in + fail-soft. LLM path (local model); never fabricates (NONE-aware).
  if (parseBoolean(process.env.MUSE_PREFERENCE_AUTOINFER_ENABLED, false)) {
    const { inferSessionPreferences } = await import("./commands-user.js");
    const result = await withBestEffort(inferSessionPreferences(), noModelPreferences());
    for (const p of result.added) {
      process.stderr.write(`🧠 Learned preference: ${p}\n`);
    }
  }
}
