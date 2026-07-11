import { describe, expect, it } from "vitest";

import { resolveAuxiliaryModel } from "./autoconfigure-model-provider.js";

const LOCAL_SESSION_MODEL = "ollama/gemma4:12b";
const CLOUD_MODEL = "gemini/gemini-2.0-flash";

describe("resolveAuxiliaryModel — precedence", () => {
  it("task-env (MUSE_AUX_VISION_MODEL) wins over the legacy MUSE_VISION_MODEL knob", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_AUX_VISION_MODEL: "ollama/a", MUSE_VISION_MODEL: "ollama/b" } as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "vision"
    });
    expect(result.model).toBe("ollama/a");
    expect(result.source).toBe("task-env");
  });

  it("legacy MUSE_VISION_MODEL wins when the task-env knob is absent", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_VISION_MODEL: "ollama/b" } as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "vision"
    });
    expect(result.model).toBe("ollama/b");
    expect(result.source).toBe("legacy-env");
  });

  it("falls back to the session model when neither knob is set", () => {
    const result = resolveAuxiliaryModel({
      env: {} as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "vision"
    });
    expect(result.model).toBe(LOCAL_SESSION_MODEL);
    expect(result.source).toBe("session");
  });

  it("the umbrella env also works for a task with no legacy knob (judge)", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_AUX_JUDGE_MODEL: "ollama/judge-model" } as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "judge"
    });
    expect(result.model).toBe("ollama/judge-model");
    expect(result.source).toBe("task-env");
  });
});

describe("resolveAuxiliaryModel — backward compatibility", () => {
  it("vision honors MUSE_VISION_MODEL exactly as the legacy resolver did", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_VISION_MODEL: "ollama/x" } as never,
      sessionModel: "ollama/s",
      task: "vision"
    });
    expect(result.model).toBe("ollama/x");
  });

  it("embedding-rescue honors MUSE_RECALL_EMBED_MODEL", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_RECALL_EMBED_MODEL: "ollama/embed-x" } as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "embedding-rescue"
    });
    expect(result.model).toBe("ollama/embed-x");
    expect(result.source).toBe("legacy-env");
  });

  it("compaction, rewrite, and judge have no legacy knob — no env falls through to the session model", () => {
    for (const task of ["compaction", "rewrite", "judge"] as const) {
      const result = resolveAuxiliaryModel({
        env: {} as never,
        sessionModel: LOCAL_SESSION_MODEL,
        task
      });
      expect(result.model).toBe(LOCAL_SESSION_MODEL);
      expect(result.source).toBe("session");
    }
  });
});

describe("resolveAuxiliaryModel — local-only / personal-context gate", () => {
  it("a cloud task-env model + isPersonalContext:true is refused — stays on the local session model", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_AUX_JUDGE_MODEL: CLOUD_MODEL } as never,
      isPersonalContext: true,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "judge"
    });
    expect(result.keptLocalForPrivacy).toBe(true);
    expect(result.model).toBe(LOCAL_SESSION_MODEL);
    expect(result.route).toBe("local");
  });

  it("a cloud task-env model + MUSE_LOCAL_ONLY=true is refused, even with no explicit personal-context flag", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_AUX_JUDGE_MODEL: CLOUD_MODEL, MUSE_LOCAL_ONLY: "true" } as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "judge"
    });
    expect(result.keptLocalForPrivacy).toBe(true);
    expect(result.model).toBe(LOCAL_SESSION_MODEL);
    expect(result.route).toBe("local");
  });

  it("a cloud task-env model with NO personal-context and NO local-only is respected as-is", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_AUX_JUDGE_MODEL: CLOUD_MODEL } as never,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "judge"
    });
    expect(result.keptLocalForPrivacy).toBe(false);
    expect(result.model).toBe(CLOUD_MODEL);
    expect(result.route).toBe("cloud");
  });

  it("a LOCAL task-env model + isPersonalContext:true is never overridden (nothing to refuse)", () => {
    const result = resolveAuxiliaryModel({
      env: { MUSE_AUX_JUDGE_MODEL: "ollama/qwen" } as never,
      isPersonalContext: true,
      sessionModel: LOCAL_SESSION_MODEL,
      task: "judge"
    });
    expect(result.keptLocalForPrivacy).toBe(false);
    expect(result.model).toBe("ollama/qwen");
    expect(result.route).toBe("local");
  });
});
