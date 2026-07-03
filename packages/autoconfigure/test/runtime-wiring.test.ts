import { describe, expect, it } from "vitest";

import type { MuseEnvironment } from "../src/index.js";
import {
  buildContextWindowOptions,
  createDefaultRuntimeHooks,
  createInputGuards,
  createOutputGuards,
  createRunnerTools,
} from "../src/runtime-wiring.js";

const env = (overrides: Record<string, string> = {}): MuseEnvironment => overrides as MuseEnvironment;
const ids = (stages: readonly { readonly id: string }[]) => stages.map((s) => s.id);

describe("createDefaultRuntimeHooks", () => {
  it("ships no default hooks", () => {
    expect(createDefaultRuntimeHooks(env())).toEqual([]);
  });
});

describe("createInputGuards", () => {
  it("under local-only (the default posture) enables ONLY the injection guard — the PII INPUT block is off so the agent isn't broken on the user's own contacts", () => {
    // No third party to leak PII to on-box ⇒ blocking the user's own emails is pure breakage.
    expect(ids(createInputGuards(env()))).toEqual(["injection-input-guard"]);
  });

  it("enables the PII INPUT guard when cloud egress is possible (local-only OFF)", () => {
    expect(ids(createInputGuards(env({ MUSE_LOCAL_ONLY: "false" })))).toEqual(["injection-input-guard", "pii-input-guard"]);
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
  it("under local-only (default) does NOT mask the answer — asking for your own contact's email shouldn't return s****@****", () => {
    expect(ids(createOutputGuards(env()))).toEqual([]);
  });

  it("enables the PII OUTPUT mask when cloud egress is possible (local-only OFF)", () => {
    expect(ids(createOutputGuards(env({ MUSE_LOCAL_ONLY: "false" })))).toEqual(["pii-output-mask"]);
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
  it("is empty unless the runner is explicitly enabled (default off)", () => {
    expect(createRunnerTools(env())).toEqual([]);
  });

  it("exposes the run_command tool when enabled", () => {
    const tools = createRunnerTools(env({ MUSE_RUNNER_ENABLED: "true" }));
    expect(tools.map((t) => t.definition.name)).toEqual(["run_command"]);
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
