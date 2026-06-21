import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAskRunLog, defaultConfigPath, firstNonEmpty, readResponseGrounded, readResponseSuccess, setConfigValue, unsetConfigValue } from "./program-helpers.js";

describe("buildAskRunLog (cli.local ask run-log payload — shared success/failure builder, #6 slice 6a)", () => {
  it("builds a success entry whose response carries success:true and the lifted fields", () => {
    const entry = buildAskRunLog({
      query: "what's my rent?",
      model: "ollama/gemma4:12b",
      timings: { totalMs: 1200 },
      confidence: 0.9,
      grounded: "grounded",
      response: "Your rent is $2000 [from notes/rent.md].",
      success: true,
      toolsUsed: []
    });
    expect(entry.source).toBe("cli.local");
    expect(entry.message).toBe("what's my rent?");
    expect(entry.model).toBe("ollama/gemma4:12b");
    expect(readResponseSuccess(entry.response)).toBe(true);
    expect((entry.response as { grounded: string }).grounded).toBe("grounded");
  });

  it("carries the decomposition trust signals when a fan-out contradicted / dropped / truncated (error-analysis flywheel fuel — a fan-out failure logged as a clean success is invisible)", () => {
    const entry = buildAskRunLog({
      query: "다음 3개 해줘: …",
      timings: { totalMs: 1 },
      grounded: "grounded",
      response: "synth",
      success: true,
      toolsUsed: [],
      decomposition: { subtaskCount: 3, truncated: true, subtaskConflicts: ["A vs B"], synthesisIncomplete: ["task X"] }
    });
    expect((entry.response as { decomposition?: { subtaskConflicts?: string[] } }).decomposition?.subtaskConflicts).toEqual(["A vs B"]);
    expect((entry.response as { decomposition?: { truncated?: boolean } }).decomposition?.truncated).toBe(true);
  });

  it("omits the decomposition key entirely on a single-run (no noise)", () => {
    const entry = buildAskRunLog({ query: "q", timings: {}, grounded: "grounded", response: "a", success: true, toolsUsed: [] });
    expect((entry.response as { decomposition?: unknown }).decomposition).toBeUndefined();
  });

  it("carries the sourceCheck signals on a grounded-but-untrusted answer (grounded≠true flywheel fuel — a grounded answer resting on untrusted sources logged as a clean success is invisible)", () => {
    const entry = buildAskRunLog({
      query: "any news about Acme?",
      timings: { totalMs: 1 },
      grounded: "grounded",
      response: "Acme acquired Beta [from feed: TechBlog].",
      success: true,
      toolsUsed: [],
      sourceCheck: { untrustedOnly: true, citationUnsupported: false, citationUncited: false }
    });
    expect((entry.response as { sourceCheck?: { untrustedOnly?: boolean } }).sourceCheck?.untrustedOnly).toBe(true);
  });

  it("omits the sourceCheck key entirely on a clean grounded answer (no noise)", () => {
    const entry = buildAskRunLog({ query: "q", timings: {}, grounded: "grounded", response: "a", success: true, toolsUsed: [] });
    expect((entry.response as { sourceCheck?: unknown }).sourceCheck).toBeUndefined();
  });

  it("builds a FAILURE entry (success:false + error) — the seam #6 needs to trace a thrown run", () => {
    const entry = buildAskRunLog({
      query: "broken run",
      model: "ollama/gemma4:12b",
      timings: { totalMs: 50 },
      grounded: "error",
      response: "",
      success: false,
      toolsUsed: [],
      errorMessage: "model timeout"
    });
    expect(readResponseSuccess(entry.response)).toBe(false); // a failed run is now traceable, not lost
    expect((entry.response as { error?: string }).error).toBe("model timeout");
  });

  it("the ask failure-path payload (grounded:null, empty response/tools) traces as a failure carrying the error — fire 6 wiring contract", () => {
    // Exactly the shape writeAskFailureLog in commands-ask emits from each of the
    // 3 ask failure paths (runtime-missing / agent-run catch / stream error).
    const entry = buildAskRunLog({
      query: "broken run", model: "ollama/gemma4:12b", timings: { totalMs: 5 },
      grounded: null, response: "", success: false, toolsUsed: [], errorMessage: "stream error: ECONNREFUSED"
    });
    expect(readResponseSuccess(entry.response)).toBe(false);
    expect(readResponseGrounded(entry.response)).toBeNull();
    expect((entry.response as { error?: string }).error).toBe("stream error: ECONNREFUSED");
    expect((entry.response as { response: string }).response).toBe("");
    expect((entry.response as { toolsUsed: readonly string[] }).toolsUsed).toEqual([]);
  });

  it("omits confidence and error when not provided (parity with the current success-path payload)", () => {
    const entry = buildAskRunLog({
      query: "q", model: "m", timings: {}, grounded: "grounded", response: "a", success: true, toolsUsed: []
    });
    expect((entry.response as Record<string, unknown>).confidence).toBeUndefined();
    expect((entry.response as Record<string, unknown>).error).toBeUndefined();
  });
});

describe("readResponseSuccess / readResponseGrounded (trace outcome labels)", () => {
  it("lifts a boolean success and a present grounded (object or explicit null)", () => {
    expect(readResponseSuccess({ success: true })).toBe(true);
    expect(readResponseSuccess({ success: false })).toBe(false);
    expect(readResponseGrounded({ grounded: { verdict: "grounded" } })).toEqual({ verdict: "grounded" });
    expect(readResponseGrounded({ grounded: null })).toBeNull(); // explicit null is a real label, kept distinct from absent
  });

  it("returns undefined when the field is absent or the wrong type (cli.local today)", () => {
    expect(readResponseSuccess({ runId: "x" })).toBeUndefined();
    expect(readResponseSuccess({ success: "yes" })).toBeUndefined();
    expect(readResponseGrounded({ runId: "x" })).toBeUndefined();
    expect(readResponseSuccess(undefined)).toBeUndefined();
  });
});

describe("defaultConfigPath", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/u/jinan");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses HOME when set, rooting config.json under ~/.config/muse", () => {
    expect(defaultConfigPath()).toBe("/u/jinan/.config/muse/config.json");
  });

  it("honours an explicit non-empty `home` argument over HOME (trimmed)", () => {
    expect(defaultConfigPath("/elsewhere")).toBe("/elsewhere/.config/muse/config.json");
    expect(defaultConfigPath("  /trimmed  ")).toBe("/trimmed/.config/muse/config.json");
  });

  it("treats an empty / whitespace-only explicit `home` argument as unset and falls through to HOME", () => {
    expect(defaultConfigPath("")).toBe("/u/jinan/.config/muse/config.json");
    expect(defaultConfigPath("   ")).toBe("/u/jinan/.config/muse/config.json");
  });

  it("FAILS LOUD when HOME and os.homedir() both resolve to empty — config.json must NOT silently land at /.config/muse/... at the filesystem root", () => {
    vi.stubEnv("HOME", "");
    try {
      const resolved = defaultConfigPath();
      expect(resolved).not.toMatch(/^\/\.config\/muse/u);
      expect(resolved).toMatch(/\/.config\/muse\/config\.json$/u);
    } catch (cause) {
      expect((cause as Error).message).toMatch(/Cannot resolve home directory/u);
    }
  });
});

describe("firstNonEmpty (readApiOptions / token precedence-chain helper)", () => {
  it("returns the first non-empty trimmed candidate", () => {
    expect(firstNonEmpty("a", "b")).toBe("a");
    expect(firstNonEmpty(undefined, "b")).toBe("b");
    expect(firstNonEmpty(undefined, undefined, "c")).toBe("c");
  });

  it("skips empty / whitespace-only / non-string candidates", () => {
    expect(firstNonEmpty("", "real")).toBe("real");
    expect(firstNonEmpty("   ", "real")).toBe("real");
    expect(firstNonEmpty("", "   ", "real")).toBe("real");
    expect(firstNonEmpty(undefined, "", "real")).toBe("real");
  });

  it("trims a non-empty candidate before returning it (a padded `--api-url` still works)", () => {
    expect(firstNonEmpty("  http://localhost:3030  ")).toBe("http://localhost:3030");
  });

  it("returns undefined when every candidate is empty / whitespace / undefined", () => {
    expect(firstNonEmpty()).toBeUndefined();
    expect(firstNonEmpty("", "   ", undefined)).toBeUndefined();
  });
});

describe("setConfigValue", () => {
  it("accepts the two supported keys + trims the value", () => {
    expect(setConfigValue({}, "apiUrl", "  http://localhost:3030  ")).toMatchObject({ apiUrl: "http://localhost:3030" });
    expect(setConfigValue({}, "defaultModel", "  qwen3:8b  ")).toMatchObject({ defaultModel: "qwen3:8b" });
  });

  it("rejects an empty / whitespace-only value", () => {
    expect(() => setConfigValue({}, "apiUrl", "   ")).toThrow(/Config value must not be empty/u);
  });

  it("rejects an unknown key with a `did you mean` hint for a near-miss typo", () => {
    expect(() => setConfigValue({}, "apirurl", "x")).toThrow(/Unsupported config key 'apirurl'.*expected one of: apiUrl, defaultModel.*did you mean 'apiUrl'/u);
    expect(() => setConfigValue({}, "deafultModel", "x")).toThrow(/did you mean 'defaultModel'/u);
  });

  it("rejects an unknown key WITHOUT a guess when nothing is close (no random suggestion)", () => {
    expect(() => setConfigValue({}, "totallydifferent", "x")).toThrow(/Unsupported config key 'totallydifferent'.*expected one of: apiUrl, defaultModel\)$/u);
  });
});

describe("unsetConfigValue — set's missing inverse (revert a key to the built-in default)", () => {
  it("clears a set key and reports wasSet=true, leaving the other key intact", () => {
    const r = unsetConfigValue({ apiUrl: "http://remote:3030", defaultModel: "qwen3:8b" }, "apiUrl");
    expect(r.wasSet).toBe(true);
    expect(r.config).toEqual({ defaultModel: "qwen3:8b" });
    expect("apiUrl" in r.config).toBe(false);
  });

  it("is a no-op (wasSet=false) when the key was never set — so the caller can say 'was not set'", () => {
    const r = unsetConfigValue({ defaultModel: "qwen3:8b" }, "apiUrl");
    expect(r.wasSet).toBe(false);
    expect(r.config).toEqual({ defaultModel: "qwen3:8b" });
  });

  it("rejects an unknown key with the same `did you mean` hint as set", () => {
    expect(() => unsetConfigValue({}, "apirurl")).toThrow(/Unsupported config key 'apirurl'.*did you mean 'apiUrl'/u);
  });
});
