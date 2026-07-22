/**
 * Self-learn tick cluster — factored out of `commands-daemon-register.ts`'s
 * `muse daemon` action so the handler stays readable. Each `make*Tick`
 * factory takes only the values its tick actually captured (env, resolved
 * file paths, shared assembly pieces, the logger) and returns the same
 * `() => Promise<void>` closure the daemon's `runTick` sequence calls —
 * behavior is unchanged, only the location of the code moved.
 *
 * A `{ current }` holder (not a bare `let`) carries each tick's own
 * last-run timestamp across calls, mirroring the scheduler-handle pattern
 * in `packages/autoconfigure/src/runtime-assembly.ts`.
 */

import { randomUUID } from "node:crypto";

import {
  createGateEmbedder,
  decayContradictedStrategies,
  distillQueuedCorrections,
  readDayRhythmConfigSafe,
  resolveFadedMemoriesFile,
  resolveLearningPauseFile,
  resolvePlaybookFile,
  resolveRecallHitsFile,
  resolveSinglePairedChannel,
  resolveSuppressedLessonsFile,
  parseBoolean,
  type DecayContradictedDeps,
  type DistillQueuedDeps
} from "@muse/autoconfigure";
import { clusterByTextSimilarity, mergePlaybookStrategies, PLAYBOOK_AVOID_BELOW, strategyTextSimilarity, validateMergeCoverage } from "@muse/agent-core";
import { FileUserMemoryStore } from "@muse/memory";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { errorMessage } from "@muse/shared";
import { decayStalePlaybookRewards, isLearningPaused, queryPlaybook, readPendingLearnEvents, readRecallHits, recordPlaybookStrategy, removePlaybookStrategy, resolveLearnQueueFile, writeFadedMemoryKeys } from "@muse/stores";
import { DEFAULT_DIGEST_HOUR, isQuietHour, resolveQuietHoursOption, runDigestFlushIfDue, type ProactiveNoticeSink, type QuietHoursOption } from "@muse/proactivity";

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { deliverEveningRecapIfDue, gatherEveningRecap, shouldFireRecap } from "./commands-recap.js";
import { daemonWorkloadCancelled, daemonWorkloadCompleted, daemonWorkloadFailed, daemonWorkloadNotReady, type GovernedDaemonTick } from "./daemon-workload-governor.js";
import { consolidatePlaybook } from "./playbook-consolidate.js";
import { runMemoryConsolidationTick } from "./memory-consolidate-tick.js";
import { promoteRecalledMemories, resolveMemoryUserId } from "./commands-memory.js";
import type { FollowupModel } from "./commands-daemon-connections.js";

/**
 * Unattended learning is ON by default (진안, 2026-07-13). It stays OFF only if
 * the user opts out with `MUSE_SELFLEARN_ENABLED=false`.
 *
 * The default was off while the machinery was unproven — and it was right to be:
 * credit assignment silently no-credited most real feedback and the decay gate
 * had NEVER fired (its cosine floors were set on the assumption that a
 * conversational cue and an imperative strategy score like paraphrases; they do
 * not — measured, eval:playbook-credit). With that fixed, the loop demonstrably
 * learns 10/13 of real feedback and mis-credits none, so the default flips.
 *
 * The brakes are unchanged and are what make an ON default safe:
 *   - every distilled strategy lands on PROBATION and is NEVER injected until
 *     the user's own reinforce graduates it;
 *   - decay is subtractive-only (it can drop a strategy below the inject line,
 *     never graduate one) and fires only on a confident contradiction;
 *   - the learning-pause kill switch is checked inside every write;
 *   - the user is TOLD on their channel when something is learned.
 */
function selfLearnEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseBoolean(env.MUSE_SELFLEARN_ENABLED, true);
}

/** Mutable last-run timestamp, shared by reference so it survives across tick calls. */
export interface TickRunState {
  current: number | undefined;
}

export interface MakeSelfLearnTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly followupModel: FollowupModel | undefined;
  readonly noticeSink: ProactiveNoticeSink;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly selfLearnDistill?: DistillQueuedDeps["distill"];
  readonly contradictionClassify?: DecayContradictedDeps["classify"];
}

/**
 * Unattended learning — the daemon distills the corrections you made in
 * past sessions (queued at correction time) into learned strategies with
 * NO manual `muse playbook distill`. Off by default; brake-first (the
 * learning-pause kill switch is checked inside distillQueuedCorrections,
 * one distill per tick); every write lands on PROBATION until a real
 * reinforce graduates it. Silent unless it actually learns something.
 */
export function makeSelfLearnTick(deps: MakeSelfLearnTickDeps): GovernedDaemonTick {
  const { env: e, stdout, followupModel, noticeSink, intervalMs, lastRunMs, selfLearnDistill, contradictionClassify } = deps;
  return async (claim): ReturnType<GovernedDaemonTick> => {
    if (!selfLearnEnabled(e)) return daemonWorkloadNotReady("disabled");
    if (!followupModel) return daemonWorkloadNotReady("unconfigured");
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return daemonWorkloadNotReady("not-due");
    try {
      if ((await readPendingLearnEvents(resolveLearnQueueFile(e))).length === 0) return daemonWorkloadNotReady("internal-brake");
    } catch {
      return daemonWorkloadNotReady("internal-brake");
    }
    if (!(claim ?? (() => true))()) return daemonWorkloadCancelled();
    lastRunMs.current = nowMs;
    try {
      const playbookFile = resolvePlaybookFile(e);
      // Snapshot probation BEFORE distill so we can act ONLY on this tick's
      // new corrections (the subtractive decay below is driven by what you
      // JUST corrected, not the whole bank re-scanned every tick).
      const probationBefore = new Set(
        (await queryPlaybook(playbookFile)).filter((p) => p.probation === true).map((p) => p.id)
      );
      const recorded = await distillQueuedCorrections({
        model: followupModel.model,
        modelProvider: followupModel.modelProvider as DistillQueuedDeps["modelProvider"],
        embed: createGateEmbedder(e),
        queueFile: resolveLearnQueueFile(e),
        playbookFile,
        suppressedLessonsFile: resolveSuppressedLessonsFile(e),
        pauseFile: resolveLearningPauseFile(e),
        ...(selfLearnDistill ? { distill: selfLearnDistill } : {})
      });
      if (recorded > 0) {
        stdout(`[${new Date(nowMs).toISOString()}] learned: +${recorded.toString()} strateg${recorded === 1 ? "y" : "ies"} from your corrections (see \`muse learned\`)\n`);
        // FELT self-learning: deliver the autonomous-learning event
        // to the user's CHANNEL — not just this console they don't watch —
        // so a background daemon's learning is PERCEIVED, not silent.
        // Quiet-hours-gated + fail-soft like every
        // notice. SAFE: the strategy stays PROBATION — this only SURFACES it,
        // never auto-applies it (the honesty-sensitive injection path is
        // untouched; nothing graduates without the user's own reinforce).
        await noticeSink.deliver({
          kind: "self-learn",
          text: `I noted ${recorded.toString()} strateg${recorded === 1 ? "y" : "ies"} from how you've corrected me lately — review with \`muse learned\` (nothing changes how I answer until you reinforce it).`,
          title: "Learned from your corrections"
        });
      }
      // Subtractive correction-decay: a NEW correction that
      // CONTRADICTS a strategy Muse currently APPLIES drops that strategy
      // below the inject line, unattended, so a LATER session stops applying
      // it. SIGN-SAFE: decay-only (never graduates), polarity-gated +
      // fail-closed (only a confident `contradict` acts), injected-only,
      // brake-first; reversible by a `muse playbook reward`.
      const newProbation = (await queryPlaybook(playbookFile))
        .filter((p) => p.probation === true && !probationBefore.has(p.id));
      if (newProbation.length > 0) {
        // Single-user daemon: this tick's new corrections are one user's. Decay
        // that user's injected strategies the corrections contradict.
        const userId = newProbation[0]!.userId;
        const decayed = await decayContradictedStrategies({
          corrections: newProbation.filter((p) => p.userId === userId).map((p) => ({ id: p.id, text: p.source ?? p.text })),
          model: followupModel.model,
          modelProvider: followupModel.modelProvider as DecayContradictedDeps["modelProvider"],
          pauseFile: resolveLearningPauseFile(e),
          playbookFile,
          userId,
          ...(contradictionClassify ? { classify: contradictionClassify } : {})
        });
        if (decayed.length > 0) {
          const first = decayed[0]!;
          stdout(`[${new Date(nowMs).toISOString()}] unlearned: stopped applying ${decayed.length.toString()} strateg${decayed.length === 1 ? "y" : "ies"} you contradicted (see \`muse learned\`)\n`);
          await noticeSink.deliver({
            kind: "self-learn",
            text: decayed.length === 1
              ? `You corrected me, so I've stopped applying "${first.text}" going forward. If that was wrong, reinforce it with \`muse playbook reward ${first.id}\`.`
              : `You corrected me, so I've stopped applying ${decayed.length.toString()} preferences I was using (see \`muse learned\`). Reinforce any I got wrong with \`muse playbook reward <id>\`.`,
            title: "Stopped applying a contradicted preference"
          });
        }
      }
      return daemonWorkloadCompleted();
    } catch { return daemonWorkloadFailed("model"); }
  };
}

export interface MakeSelfLearnDecayTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly noticeSink: ProactiveNoticeSink;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
}

/**
 * Disuse-decay — the FORGETTING half of continuous RL over the learned
 * bank (the distill step adds new strategies; this fades old ones). A
 * positive-reward strategy you stopped using sinks back toward neutral so
 * a one-off thumbs-up can't steer the agent forever. Same MUSE_SELFLEARN
 * switch + the learning-pause brake (a paused user's bank is frozen);
 * model-free, so it runs without a model, on a slow daily cadence.
 */
export function makeSelfLearnDecayTick(deps: MakeSelfLearnDecayTickDeps): GovernedDaemonTick {
  const { env: e, stdout, noticeSink, intervalMs, lastRunMs } = deps;
  return async (claim): ReturnType<GovernedDaemonTick> => {
    if (!selfLearnEnabled(e)) return daemonWorkloadNotReady("disabled");
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return daemonWorkloadNotReady("not-due");
    try {
      if (await isLearningPaused(resolveLearningPauseFile(e))) return daemonWorkloadNotReady("internal-brake");
      const playbookFile = resolvePlaybookFile(e);
      const existing = await queryPlaybook(playbookFile);
      if (!existing.some((entry) => entry.probation !== true && (entry.reward ?? 0) > 0)) {
        return daemonWorkloadNotReady("internal-brake");
      }
      if (!(claim ?? (() => true))()) return daemonWorkloadCancelled();
      lastRunMs.current = nowMs;
      const beforeReward = new Map(existing.map((s) => [s.id, s.reward ?? 0]));
      const decayed = await decayStalePlaybookRewards(playbookFile, { nowMs });
      if (decayed > 0) {
        stdout(`[${new Date(nowMs).toISOString()}] decay: ${decayed.toString()} stale strateg${decayed === 1 ? "y" : "ies"} faded toward neutral\n`);
        // FELT forgetting: when a preference you TAUGHT crosses from
        // healthy into near-forgotten (reward >1 → ≤1) purely from disuse, tell
        // you so you can RESCUE it before it's gone — the symmetric other half
        // of the learned-notice. SAFE: the decay
        // itself is the existing model-free RL, untouched.
        const fading = (await queryPlaybook(playbookFile))
          .filter((s) => { const prev = beforeReward.get(s.id); return prev !== undefined && prev > 1 && (s.reward ?? 0) <= 1; })
          .sort((a, b) => (a.reward ?? 0) - (b.reward ?? 0))[0];
        if (fading) {
          await noticeSink.deliver({
            kind: "self-learn-decay",
            text: `A preference you taught me — "${fading.text}" — is fading from disuse. Reinforce it with \`muse playbook reward ${fading.id.slice(0, 8)}\` to keep it.`,
            title: "A preference is fading"
          });
        }
      }
      return daemonWorkloadCompleted();
    } catch { return daemonWorkloadFailed("io"); }
  };
}

export interface MakePlaybookConsolidateTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly followupModel: FollowupModel | undefined;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly consolidateMerge?: (texts: readonly string[]) => Promise<string | undefined>;
  readonly consolidateValidate?: (originals: readonly string[], merged: string) => Promise<{ readonly accept: boolean; readonly reason: string; readonly lost?: readonly string[] }>;
}

/**
 * Autonomous playbook CONSOLIDATE — the unattended distill writes
 * PROBATION strategies; exact/lexical near-duplicates are deduped at write
 * time, but SEMANTIC paraphrases the lexical dedup misses still accumulate.
 * This merges near-duplicate PROBATION strategies into one via the LLM
 * merger behind the SkillOpt held-out coverage gate (a merge commits only
 * if the result still covers every original; else the originals are kept).
 * SAFETY: it operates ONLY on probation strategies and the merged strategy
 * STAYS on probation — autonomous consolidation NEVER graduates a guess
 * into the injected block (graduation stays bound to a positive user act),
 * and the graduated/injected bank is never touched. Brake-first: ≤1 cluster
 * per tick, the same MUSE_SELFLEARN switch + learning-pause brake, off
 * without a model.
 */
export function makePlaybookConsolidateTick(deps: MakePlaybookConsolidateTickDeps): GovernedDaemonTick {
  const { env: e, stdout, followupModel, intervalMs, lastRunMs, consolidateMerge, consolidateValidate } = deps;
  return async (claim): ReturnType<GovernedDaemonTick> => {
    if (!selfLearnEnabled(e)) return daemonWorkloadNotReady("disabled");
    if (!followupModel) return daemonWorkloadNotReady("unconfigured");
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return daemonWorkloadNotReady("not-due");
    try {
      if (await isLearningPaused(resolveLearningPauseFile(e))) return daemonWorkloadNotReady("internal-brake");
      const playbookFile = resolvePlaybookFile(e);
      // The playbook file is a single-user ~/.muse bucket — operate on the
      // whole file (no external userId resolution); the merged strategy
      // inherits the cluster's userId.
      const entries = await queryPlaybook(playbookFile);
      // ONLY fresh PENDING learnings: probation AND not-yet-avoided. The
      // graduated / avoided bank is never autonomously merged.
      const pending = entries.filter((x) => x.probation === true && (x.reward ?? 0) > PLAYBOOK_AVOID_BELOW);
      const clusters = clusterByTextSimilarity(pending, (x) => x.text, strategyTextSimilarity, 0.6).filter((c) => c.length >= 2);
      if (clusters.length === 0) return daemonWorkloadNotReady("internal-brake");
      if (!(claim ?? (() => true))()) return daemonWorkloadCancelled();
      lastRunMs.current = nowMs;
      const cluster = clusters[0]!; // ≤1 per tick (brake-first)
      const userId = cluster[0]!.userId;
      const tag = cluster.find((x) => x.tag)?.tag;
      const merge = consolidateMerge ?? ((texts) =>
        mergePlaybookStrategies(texts, { model: followupModel.model, modelProvider: followupModel.modelProvider as Parameters<typeof mergePlaybookStrategies>[1]["modelProvider"] }));
      const validate = consolidateValidate ?? (async (originals: readonly string[], mergedText: string) => {
        const verdict = await validateMergeCoverage(originals.map((t) => ({ label: t, text: t })), { label: mergedText.slice(0, 40), text: mergedText }, { embed: createGateEmbedder(e) });
        return { accept: verdict.accept, lost: verdict.lost, reason: verdict.reason };
      });
      const { merged } = await consolidatePlaybook([cluster], {
        apply: true,
        log: () => { /* the daemon logs the single outcome below */ },
        merge,
        // SAFETY: the merged strategy STAYS on probation — never graduate.
        record: async (text) => {
          await recordPlaybookStrategy(playbookFile, {
            createdAt: new Date(nowMs).toISOString(),
            id: `pb_${randomUUID()}`,
            origin: "grounded",
            probation: true,
            text,
            userId,
            ...(tag ? { tag } : {})
          });
        },
        remove: async (id) => { await removePlaybookStrategy(playbookFile, id); },
        validate
      });
      if (merged > 0) stdout(`[${new Date(nowMs).toISOString()}] consolidate: merged ${cluster.length.toString()} near-duplicate pending learning(s) into 1 (still on probation; see \`muse learned\`)\n`);
      return daemonWorkloadCompleted();
    } catch { return daemonWorkloadFailed("model"); }
  };
}

export interface MakeMemoryConsolidateTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly lastRunMs: TickRunState;
}

export function makeMemoryConsolidateTick(deps: MakeMemoryConsolidateTickDeps): GovernedDaemonTick {
  const { env: e, stdout, lastRunMs } = deps;
  return async (claim): ReturnType<GovernedDaemonTick> => {
    if (!selfLearnEnabled(e)) return daemonWorkloadNotReady("disabled");
    const sleepPromoteEnabled = parseBoolean(e.MUSE_SLEEP_PROMOTE, false);
    const persist = sleepPromoteEnabled
      ? async () => {
          const userId = resolveMemoryUserId(undefined);
          const store = new FileUserMemoryStore();
          const result = await promoteRecalledMemories({
            store,
            userId,
            readHits: () => readRecallHits(resolveRecallHitsFile(e))
          });
          return { promoted: result.promoted.length };
        }
      : undefined;
    const previous = lastRunMs.current;
    let cancelled = false;
    try {
      const nextState = await runMemoryConsolidationTick({
        claim: () => {
          const accepted = (claim ?? (() => true))();
          cancelled = !accepted;
          return accepted;
        },
        enabled: true,
        nowMs: Date.now(),
        lastRunMs: previous,
        readHits: () => readRecallHits(resolveRecallHitsFile(e)),
        log: (line) => stdout(line + "\n"),
        useActrRanking: true,
        persistFade: (fadeKeys) => writeFadedMemoryKeys(resolveFadedMemoriesFile(e), fadeKeys, Date.now()),
        ...(persist !== undefined ? { persist } : {})
      });
      lastRunMs.current = nextState.lastRunMs;
      if (cancelled) return daemonWorkloadCancelled();
      if (nextState.lastRunMs === previous) return daemonWorkloadNotReady("not-due");
      return daemonWorkloadCompleted();
    } catch { return daemonWorkloadFailed("io"); }
  };
}

export interface MakeRecapTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly destination: string;
  readonly recapHour: number;
  readonly recapSidecar: string;
}

/**
 * Evening recap — a once-a-day proactive digest of what got done today +
 * what's coming up, delivered after MUSE_RECAP_HOUR (default 21:00) and
 * self-deduped to once per calendar day via a sidecar. Off by default;
 * turns `muse recap` from an on-demand report into anticipation.
 */
export function makeRecapTick(deps: MakeRecapTickDeps): GovernedDaemonTick {
  const { env: e, stdout, messagingRegistry, provider, destination, recapHour, recapSidecar } = deps;
  return async (claim): ReturnType<GovernedDaemonTick> => {
    if (!parseBoolean(e.MUSE_RECAP_ENABLED, false)) return daemonWorkloadNotReady("disabled");
    let lastFiredISO: string | undefined;
    try {
      lastFiredISO = (JSON.parse(readFileSync(recapSidecar, "utf8")) as { lastFired?: string }).lastFired;
    } catch { /* no sidecar yet ⇒ never fired */ }
    const now = new Date();
    if (!shouldFireRecap(now, lastFiredISO, recapHour)) return daemonWorkloadNotReady("not-due");
    if (!(claim ?? (() => true))()) return daemonWorkloadCancelled();
    try {
      const outcome = await deliverEveningRecapIfDue({
        now,
        recapHour,
        ...(lastFiredISO !== undefined ? { lastFiredISO } : { lastFiredISO: undefined }),
        gather: (now) => gatherEveningRecap(e, now),
        send: async (text) => { await messagingRegistry.send(provider, { destination, text }); },
        recordFired: (when) => {
          try {
            mkdirSync(dirname(recapSidecar), { recursive: true });
            writeFileSync(recapSidecar, JSON.stringify({ lastFired: when.toISOString() }), "utf8");
          } catch { /* fail-soft */ }
        }
      });
      if (outcome === "fired") stdout(`[${new Date().toISOString()}] recap: delivered the evening recap\n`);
      return daemonWorkloadCompleted();
    } catch { return daemonWorkloadFailed("provider"); }
  };
}

export interface MakeDigestFlushTickDeps {
  readonly stdout: (message: string) => void;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly destination: string;
  readonly digestEnabled: boolean;
  readonly quietHours: QuietHoursOption | undefined;
  readonly digestQueueFile: string;
  readonly digestHourRaw: number | undefined;
  readonly digestSentFile: string;
  /** `~/.config/muse/config.json` — read LIVE every tick so a web-console day-rhythm toggle takes effect without a daemon restart. */
  readonly dayRhythmConfigFile: string;
  /** `~/.muse/channel-owners.json` — day-rhythm's auto-route source when `provider` is still the "log" default. */
  readonly channelOwnersFile: string;
  /** Deterministic test seam; production uses `runDigestFlushIfDue`. */
  readonly digestFlush?: typeof runDigestFlushIfDue;
  /** Clock seam shared by the hour preflight and digest core. */
  readonly now?: () => Date;
}

/**
 * Daily digest flush — the delivery half of the interruption budget:
 * whatever the unasked notice loops suppressed into the digest queue over
 * the day goes out as ONE compiled message. On by default
 * (MUSE_DIGEST_ENABLED); mirrors apps/api's digest-tick so the CLI daemon
 * (which runs several loops the API daemon doesn't duplicate) never leaves
 * its own suppressed notices stranded.
 *
 * Day-rhythm overlay (opt-in, `dayRhythm.enabled` in config.json): when
 * `--digest-hour`/MUSE_DIGEST_HOUR was NOT explicitly set, the digest fires
 * at `dayRhythm.eveningHour` instead of the hardcoded default; when
 * `provider` is still the "log" sink default, the flush auto-routes to the
 * single paired messaging channel. No paired channel ⇒ an honest skip,
 * never a silent log-sink send (fail-close).
 */
export function makeDigestFlushTick(deps: MakeDigestFlushTickDeps): GovernedDaemonTick {
  const { stdout, messagingRegistry, provider, destination, digestEnabled, quietHours, digestQueueFile, digestHourRaw, digestSentFile, dayRhythmConfigFile, channelOwnersFile } = deps;
  const digestFlush = deps.digestFlush ?? runDigestFlushIfDue;
  return async (claim): ReturnType<GovernedDaemonTick> => {
    if (!digestEnabled) return daemonWorkloadNotReady("disabled");
    const activeQuietHours = resolveQuietHoursOption(quietHours);
    const now = deps.now?.() ?? new Date();
    if (activeQuietHours && isQuietHour(now.getHours(), activeQuietHours)) return daemonWorkloadNotReady("internal-brake");
    const dayRhythm = await readDayRhythmConfigSafe(dayRhythmConfigFile);
    let effectiveProvider = provider;
    let effectiveDestination = destination;
    let effectiveDigestHour = digestHourRaw;
    if (dayRhythm.enabled) {
      if (effectiveDigestHour === undefined) {
        effectiveDigestHour = dayRhythm.eveningHour;
      }
      if (provider === "log") {
        const paired = await resolveSinglePairedChannel(channelOwnersFile, messagingRegistry);
        if (!paired) {
          stdout(`[${new Date().toISOString()}] digest: day rhythm on but no channel paired\n`);
          return daemonWorkloadNotReady("unconfigured");
        }
        effectiveProvider = paired.providerId;
        effectiveDestination = paired.destination;
      }
    }
    const digestHour = effectiveDigestHour ?? DEFAULT_DIGEST_HOUR;
    if (now.getHours() !== digestHour) return daemonWorkloadNotReady("not-due");
    let claimed = false;
    const claimDigest = (): boolean => {
      const accepted = (claim ?? (() => true))();
      if (accepted) claimed = true;
      return accepted;
    };
    try {
      const summary = await digestFlush({
        claim: claimDigest,
        destination: effectiveDestination,
        digestFile: digestQueueFile,
        ...(effectiveDigestHour !== undefined && Number.isFinite(effectiveDigestHour) ? { digestHour: effectiveDigestHour } : {}),
        now: () => now,
        providerId: effectiveProvider,
        registry: messagingRegistry,
        sentFile: digestSentFile
      });
      if (summary.outcome === "sent" || summary.errors.length > 0) {
        const tag = `[${new Date().toISOString()}]`;
        stdout(`${tag} digest: ${summary.outcome} (${summary.itemCount.toString()} item(s))`);
        if (summary.errors.length > 0) {
          stdout(`, ${summary.errors.length.toString()} error(s)`);
          for (const error of summary.errors) stdout(`\n  ! ${error}`);
        }
        stdout("\n");
      }
      switch (summary.outcome) {
        case "sent":
          if (!claimed) throw new Error("digest flush reported sent without claiming");
          return daemonWorkloadCompleted();
        case "send-failed":
          if (!claimed) throw new Error("digest flush reported send-failed without claiming");
          return daemonWorkloadFailed("provider");
        case "cancelled-before-claim":
          return daemonWorkloadCancelled();
        case "lock-error":
        case "lock-held":
        case "preflight-failed":
          return daemonWorkloadNotReady("internal-brake");
        case "already-sent-today":
        case "empty":
        case "not-due":
          return daemonWorkloadNotReady("not-due");
      }
    } catch (cause) {
      stdout(`[${new Date().toISOString()}] digest: ${claimed ? "failed" : "preflight-failed"} (${errorMessage(cause)})\n`);
      return claimed ? daemonWorkloadFailed("provider") : daemonWorkloadNotReady("internal-brake");
    }
  };
}
