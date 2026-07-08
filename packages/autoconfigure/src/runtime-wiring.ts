/**
 * Runtime-wiring helpers extracted from `index.ts`. Each function
 * here turns env / store state into one piece of the
 * `createMuseRuntimeAssembly` factory:
 *
 *   - `createPersonalToolExposurePolicy` — single-user-friendly
 *     ToolExposurePolicy (allows `write` tools without requiring a
 *     workspace-edit prompt shape).
 *   - `createScheduledAgentExecutor` — bridge between
 *     `DynamicScheduler.run` and `AgentRuntime.run`.
 *   - `createDefaultRuntimeHooks` — empty by design for
 *     personal-Muse; runtimes wire hooks directly.
 *   - `createInputGuards` / `createOutputGuards` — env-toggled
 *     injection / PII / system-prompt-leakage stages.
 *   - `createRunnerTools` — MUSE_RUNNER_ENABLED-gated Rust runner
 *     bridge.
 *
 * Lifting these out of `index.ts` shrinks the big runtime-assembly
 * file by ~125 LOC and keeps each helper next to its peers rather
 * than scattered after the assembly factory body.
 */

import {
  createInjectionInputGuard,
  createPiiInputGuard,
  createPiiMaskingOutputGuard,
  createSystemPromptLeakageOutputGuard,
  type AgentRuntime,
  type GuardStage,
  type HookStage,
  type OutputGuardStage
} from "@muse/agent-core";
import { DEFAULT_WORKING_BUDGET_RATIO, type ConversationTrimOptions } from "@muse/memory";
import type { ScheduledAgentExecutor } from "@muse/scheduler";
import {
  createDefaultToolExposurePolicy,
  createRustRunnerTool,
  type MuseTool,
  type ToolExposurePolicy
} from "@muse/tools";

import { parseBoolean, parseCsv, parseInteger, parseOptionalString } from "./env-parsers.js";
import { ConfigurationError, type MuseEnvironment } from "./index.js";

export function createPersonalToolExposurePolicy(env: MuseEnvironment): ToolExposurePolicy {
  // Personal pivot: the agent operates in a single-user environment
  // with no shared workspace to protect, so the workspace-mutation-
  // intent heuristic is the wrong default. Allow `write` tools (notes
  // save, calendar add/update/delete, etc.) without requiring a
  // workspace-edit prompt shape. Operators can still tighten via the
  // env var if running Muse in a multi-user context.
  return createDefaultToolExposurePolicy({
    allowWriteWithoutMutationIntent: parseBoolean(env.MUSE_ALLOW_WRITE_WITHOUT_MUTATION_INTENT, true)
  });
}

export function createScheduledAgentExecutor(
  runtime: () => AgentRuntime | undefined,
  defaultModel: string | undefined
): ScheduledAgentExecutor {
  return {
    async execute(job) {
      const agentRuntime = runtime();

      if (!agentRuntime) {
        throw new ConfigurationError("Scheduled agent execution requires a configured model provider");
      }

      const result = await agentRuntime.run({
        messages: [
          ...(job.agentSystemPrompt ? [{ content: job.agentSystemPrompt, role: "system" as const }] : []),
          { content: job.agentPrompt ?? "", role: "user" }
        ],
        metadata: {
          jobId: job.id,
          scheduler: true
        },
        model: job.agentModel ?? defaultModel ?? "default"
      });

      return result.response.output;
    }
  };
}

/**
 * Personal-Muse: no env-driven default runtime hooks. Muse
 * deployments wire hooks directly when assembling the runtime.
 */
export function createDefaultRuntimeHooks(_env: MuseEnvironment): readonly HookStage[] {
  return [];
}

/**
 * Build `AgentRuntime.contextWindow` options from env.
 *
 * Working-budget compaction: proactive compaction at
 * ~40% of nominal keeps quality high before the hard cap is hit
 * (Anthropic effective-context-engineering / NoLiMa context-rot
 * research). Operators override the soft target via
 * `MUSE_LLM_WORKING_BUDGET_TOKENS`; `0` disables proactive compaction
 * (legacy hard-cap-only behavior).
 *
 * Context Engineering Phase 5: `MUSE_COMPACTION_STRATEGY=importance`
 * flips the trim to score-aware so multi-day task state survives
 * longer than casual chat. Default stays `temporal`
 * (legacy oldest-first).
 */
export function buildContextWindowOptions(env: MuseEnvironment): ConversationTrimOptions {
  const maxContextWindowTokens = parseInteger(env.MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS, 128_000);
  const outputReserveTokens = parseInteger(env.MUSE_LLM_MAX_OUTPUT_TOKENS, 4_096);
  const explicitWorkingBudget = env.MUSE_LLM_WORKING_BUDGET_TOKENS;
  const workingBudgetTokens = explicitWorkingBudget !== undefined
    ? parseInteger(explicitWorkingBudget, 0)
    : Math.floor(maxContextWindowTokens * DEFAULT_WORKING_BUDGET_RATIO);
  const strategyRaw = env.MUSE_COMPACTION_STRATEGY?.trim().toLowerCase();
  const compactionStrategy: "temporal" | "importance" =
    strategyRaw === "importance" ? "importance" : "temporal";
  const importanceThresholdRaw = env.MUSE_COMPACTION_IMPORTANCE_THRESHOLD?.trim();
  const importanceThreshold = importanceThresholdRaw
    ? Number.parseFloat(importanceThresholdRaw)
    : Number.NaN;
  return {
    maxContextWindowTokens,
    outputReserveTokens,
    // 0 disables; positive values pass through to trimConversationMessages.
    ...(workingBudgetTokens > 0 ? { workingBudgetTokens } : {}),
    compactionStrategy,
    ...(Number.isFinite(importanceThreshold) ? { importanceThreshold } : {})
  };
}

export function createInputGuards(env: MuseEnvironment): readonly GuardStage[] {
  if (!parseBoolean(env.MUSE_INPUT_GUARDS_ENABLED, true)) {
    return [];
  }

  const guards: GuardStage[] = [];

  if (parseBoolean(env.MUSE_INPUT_GUARD_INJECTION_ENABLED, true)) {
    guards.push(createInjectionInputGuard());
  }

  // The PII INPUT guard BLOCKS a whole run whose input carries a private
  // identifier (email / phone / …). Its threat model is PII *egressing to a
  // third-party cloud model* — but under local-only (the DEFAULT posture) the
  // model is on-box and there is no third party, so the only effect is breaking
  // the agent on the user's OWN contacts/notes (which contain emails by nature):
  // "draft an email to Sarah" fail-closes the run. So it fires by default ONLY
  // when cloud egress is actually possible (MUSE_LOCAL_ONLY off); an explicit
  // MUSE_INPUT_GUARD_PII_ENABLED still forces it on under any posture. (The PII
  // OUTPUT mask stays on regardless — that's transcript/log hygiene, not a block.)
  const cloudEgressPossible = !parseBoolean(env.MUSE_LOCAL_ONLY, false);
  if (parseBoolean(env.MUSE_INPUT_GUARD_PII_ENABLED, cloudEgressPossible)) {
    guards.push(createPiiInputGuard());
  }

  return guards;
}

export function createOutputGuards(env: MuseEnvironment): readonly OutputGuardStage[] {
  if (!parseBoolean(env.MUSE_OUTPUT_GUARDS_ENABLED, true)) {
    return [];
  }

  const guards: OutputGuardStage[] = [];

  // The PII OUTPUT mask REWRITES the agent's answer (and the cached / recorded
  // copy), redacting any email/phone to `s****@****`. On a local "tell it
  // everything" assistant that means asking "what's my dentist's email?" gets a
  // MASKED answer for the user's OWN contact — the answer is the thing the user
  // wants. It also doesn't prevent egress (under cloud the PII already left on
  // the INPUT side), so its only effect is corrupting the user-facing answer +
  // store. So, mirroring the PII INPUT guard, it fires by default ONLY when cloud
  // egress is possible (MUSE_LOCAL_ONLY off); an explicit
  // MUSE_OUTPUT_GUARD_PII_MASK_ENABLED forces it on under any posture.
  const cloudEgressPossible = !parseBoolean(env.MUSE_LOCAL_ONLY, false);
  if (parseBoolean(env.MUSE_OUTPUT_GUARD_PII_MASK_ENABLED, cloudEgressPossible)) {
    guards.push(createPiiMaskingOutputGuard());
  }

  const canaryTokens = parseCsv(env.MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_CANARY_TOKENS);
  if (parseBoolean(env.MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_LEAK_ENABLED, false) && canaryTokens && canaryTokens.length > 0) {
    guards.push(createSystemPromptLeakageOutputGuard({ canaryTokens }));
  }

  return guards;
}

export function createRunnerTools(env: MuseEnvironment): readonly MuseTool[] {
  if (!parseBoolean(env.MUSE_RUNNER_ENABLED, false)) {
    return [];
  }

  return [
    createRustRunnerTool({
      runnerPath: parseOptionalString(env.MUSE_RUNNER_PATH) ?? "muse-runner"
    })
  ];
}
