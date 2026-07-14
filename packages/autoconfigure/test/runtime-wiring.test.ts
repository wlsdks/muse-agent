import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "@muse/agent-core";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { ScheduledJob } from "@muse/scheduler";
import { describe, expect, it, vi } from "vitest";

import type { MuseEnvironment } from "../src/index.js";
import {
  buildContextWindowOptions,
  createDefaultRuntimeHooks,
  createInputGuards,
  createOutputGuards,
  createRunnerTools,
  createSchedulerMessagingSender,
  resolveStreamIdleTimeoutMs,
} from "../src/runtime-wiring.js";

const env = (overrides: Record<string, string> = {}): MuseEnvironment => overrides as MuseEnvironment;
const ids = (stages: readonly { readonly id: string }[]) => stages.map((s) => s.id);
const runnerToolCases: readonly { readonly name: string; readonly runtimeEnv: MuseEnvironment }[] = [
  { name: "unset", runtimeEnv: env() },
  { name: "MUSE_RUNNER_ENABLED=false", runtimeEnv: env({ MUSE_RUNNER_ENABLED: "false" }) },
  { name: "MUSE_RUNNER_ENABLED=true", runtimeEnv: env({ MUSE_RUNNER_ENABLED: "true" }) },
  {
    name: "MUSE_RUNNER_ENABLED=true with an arbitrary runner path",
    runtimeEnv: env({ MUSE_RUNNER_ENABLED: "true", MUSE_RUNNER_PATH: "/arbitrary/muse-runner" })
  },
  {
    name: "MUSE_LOCAL_ONLY=true with enabled runner and an invalid path",
    runtimeEnv: env({
      MUSE_LOCAL_ONLY: "true",
      MUSE_RUNNER_ENABLED: "true",
      MUSE_RUNNER_PATH: "/definitely-not-a-muse-runner"
    })
  }
];

describe("createDefaultRuntimeHooks", () => {
  it("ships no default hooks", () => {
    expect(createDefaultRuntimeHooks(env())).toEqual([]);
  });
});

describe("createInputGuards", () => {
  it("under local-only (MUSE_LOCAL_ONLY=true) enables ONLY the injection guard — the PII INPUT block is off so the agent isn't broken on the user's own contacts", () => {
    // No third party to leak PII to on-box ⇒ blocking the user's own emails is pure breakage.
    expect(ids(createInputGuards(env({ MUSE_LOCAL_ONLY: "true" })))).toEqual(["injection-input-guard"]);
  });

  it("by DEFAULT (cloud egress possible) enables both the injection and PII INPUT guards", () => {
    expect(ids(createInputGuards(env()))).toEqual(["injection-input-guard", "pii-input-guard"]);
  });

  it("an explicit MUSE_INPUT_GUARD_PII_ENABLED forces the PII guard on even under local-only", () => {
    expect(ids(createInputGuards(env({ MUSE_INPUT_GUARD_PII_ENABLED: "true" })))).toEqual(["injection-input-guard", "pii-input-guard"]);
  });

  it("returns nothing when the master flag is off", () => {
    expect(createInputGuards(env({ MUSE_INPUT_GUARDS_ENABLED: "false" }))).toEqual([]);
  });

  it("drops each guard independently when its flag is off", () => {
    // Force PII on (local-only would otherwise leave it off) to isolate the injection toggle.
    expect(ids(createInputGuards(env({ MUSE_INPUT_GUARD_INJECTION_ENABLED: "false", MUSE_INPUT_GUARD_PII_ENABLED: "true" })))).toEqual(["pii-input-guard"]);
    expect(ids(createInputGuards(env({ MUSE_LOCAL_ONLY: "false", MUSE_INPUT_GUARD_PII_ENABLED: "false" })))).toEqual(["injection-input-guard"]);
  });
});

describe("createOutputGuards", () => {
  it("under local-only (MUSE_LOCAL_ONLY=true) does NOT mask the answer — asking for your own contact's email shouldn't return s****@****", () => {
    expect(ids(createOutputGuards(env({ MUSE_LOCAL_ONLY: "true" })))).toEqual([]);
  });

  it("by DEFAULT (cloud egress possible) enables the PII OUTPUT mask", () => {
    expect(ids(createOutputGuards(env()))).toEqual(["pii-output-mask"]);
  });

  it("an explicit MUSE_OUTPUT_GUARD_PII_MASK_ENABLED forces masking on even under local-only", () => {
    expect(ids(createOutputGuards(env({ MUSE_OUTPUT_GUARD_PII_MASK_ENABLED: "true" })))).toEqual(["pii-output-mask"]);
  });

  it("returns nothing when the master flag is off", () => {
    expect(createOutputGuards(env({ MUSE_OUTPUT_GUARDS_ENABLED: "false" }))).toEqual([]);
  });

  it("adds the system-prompt-leak guard only when enabled AND canary tokens are supplied", () => {
    // Force the PII mask on to isolate the canary-guard behavior from the posture default.
    expect(ids(createOutputGuards(env({ MUSE_OUTPUT_GUARD_PII_MASK_ENABLED: "true", MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_LEAK_ENABLED: "true" })))).toEqual([
      "pii-output-mask",
    ]); // enabled but no canary → not added
    expect(
      ids(
        createOutputGuards(
          env({ MUSE_OUTPUT_GUARD_PII_MASK_ENABLED: "true", MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_LEAK_ENABLED: "true", MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_CANARY_TOKENS: "SECRET1,SECRET2" }),
        ),
      ),
    ).toEqual(["pii-output-mask", "system-prompt-leakage-output-guard"]);
  });
});

describe("createRunnerTools", () => {
  for (const { name, runtimeEnv } of runnerToolCases) {
    it(`does not create a model-callable general runner when ${name}`, () => {
      expect(createRunnerTools(runtimeEnv)).toEqual([]);
    });
  }
});

describe("resolveStreamIdleTimeoutMs (MUSE_STREAM_IDLE_TIMEOUT_MS wiring)", () => {
  it("falls back to the 3-min agent-core default when unset — behavior unchanged for operators who don't set it", () => {
    expect(resolveStreamIdleTimeoutMs(env())).toBe(180_000);
    expect(resolveStreamIdleTimeoutMs(env())).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });

  it("honors a positive override so a black-holed local stream can be failed in 8s instead of 3 min", () => {
    expect(resolveStreamIdleTimeoutMs(env({ MUSE_STREAM_IDLE_TIMEOUT_MS: "8000" }))).toBe(8_000);
  });

  it("maps 0 / negative / non-numeric back to the default — the knob can only SHORTEN a real stall, never disable the guard", () => {
    expect(resolveStreamIdleTimeoutMs(env({ MUSE_STREAM_IDLE_TIMEOUT_MS: "0" }))).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(resolveStreamIdleTimeoutMs(env({ MUSE_STREAM_IDLE_TIMEOUT_MS: "-5000" }))).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(resolveStreamIdleTimeoutMs(env({ MUSE_STREAM_IDLE_TIMEOUT_MS: "8s" }))).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(resolveStreamIdleTimeoutMs(env({ MUSE_STREAM_IDLE_TIMEOUT_MS: "  " }))).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });
});

describe("buildContextWindowOptions", () => {
  it("derives the working budget as a ratio of the context window by default", () => {
    expect(buildContextWindowOptions(env())).toEqual({
      maxContextWindowTokens: 128_000,
      outputReserveTokens: 4_096,
      workingBudgetTokens: 51_200, // floor(128000 * 0.4)
      compactionStrategy: "temporal",
    });
  });

  it("omits workingBudgetTokens when explicitly set to 0 (proactive compaction off)", () => {
    const options = buildContextWindowOptions(env({ MUSE_LLM_WORKING_BUDGET_TOKENS: "0" }));
    expect(options).not.toHaveProperty("workingBudgetTokens");
    expect(options.compactionStrategy).toBe("temporal");
  });

  it("switches to importance strategy and carries a finite threshold when configured", () => {
    expect(buildContextWindowOptions(env({ MUSE_COMPACTION_STRATEGY: "importance", MUSE_COMPACTION_IMPORTANCE_THRESHOLD: "0.4" }))).toMatchObject({
      compactionStrategy: "importance",
      importanceThreshold: 0.4,
    });
  });

  it("ignores a non-finite importance threshold", () => {
    expect(buildContextWindowOptions(env({ MUSE_COMPACTION_IMPORTANCE_THRESHOLD: "abc" }))).not.toHaveProperty(
      "importanceThreshold",
    );
  });

  it("is reachable from the public @muse/autoconfigure barrel (../src/index.js), not just runtime-wiring.js directly — this is the single source of truth the chat /compact preview relies on", async () => {
    const barrel = await import("../src/index.js");
    expect(barrel.buildContextWindowOptions).toBe(buildContextWindowOptions);
    expect(barrel.buildContextWindowOptions(env())).toEqual(buildContextWindowOptions(env()));
  });
});

function fakeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    cronExpression: "0 9 * * *",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    enabled: true,
    id: "job-1",
    jobType: "agent",
    maxRetryCount: 3,
    name: "morning-brief",
    retryOnFailure: false,
    tags: [],
    timezone: "UTC",
    toolArguments: {},
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("createSchedulerMessagingSender — AC3, delivers a scheduled job's result to notificationChannelId", () => {
  it("splits 'provider:destination' and sends through that provider", async () => {
    const send = vi.fn().mockResolvedValue({ providerId: "telegram", status: "sent" });
    const registry = { send } as unknown as MessagingProviderRegistry;
    const sender = createSchedulerMessagingSender(registry);

    await sender.sendMessage("ignored-target", "today's brief", fakeJob({ notificationChannelId: "telegram:12345" }));

    expect(send).toHaveBeenCalledWith("telegram", { destination: "12345", text: "today's brief" });
  });

  it("a bare destination with no provider prefix defaults to the always-registered 'log' provider", async () => {
    const send = vi.fn().mockResolvedValue({ providerId: "log", status: "sent" });
    const registry = { send } as unknown as MessagingProviderRegistry;
    const sender = createSchedulerMessagingSender(registry);

    await sender.sendMessage("ignored-target", "hello", fakeJob({ notificationChannelId: "@me" }));

    expect(send).toHaveBeenCalledWith("log", { destination: "@me", text: "hello" });
  });

  it("a job with no notificationChannelId (only webhookUrl) does NOT call the registry — webhook delivery is out of scope for this sender", async () => {
    const send = vi.fn();
    const registry = { send } as unknown as MessagingProviderRegistry;
    const sender = createSchedulerMessagingSender(registry);

    await sender.sendMessage("https://example.com/hook", "text", fakeJob({ webhookUrl: "https://example.com/hook" }));

    expect(send).not.toHaveBeenCalled();
  });
});
