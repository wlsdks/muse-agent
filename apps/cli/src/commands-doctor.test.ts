import { describe, expect, it } from "vitest";

import {
  classifyHomeAlertsConfig,
  classifyMcpServersField,
  classifyWebWatchConfig,
  embedModelCheck,
  episodeIndexHealth,
  findOllamaModelTag,
  localOnlyCheck,
  modelEnvCheck,
  notesIndexHealth,
  buildCalibrationReport,
  formatCalibration,
  formatDevFixableWeaknesses,
  formatRunOutcomes,
  formatWeaknesses,
  parseAlpha,
  weaknessFuelCheck,
  parseNotesIndexEmbedModel,
  resolveMuseEnvPath,
  selfLearningCheck,
  type OllamaTagsEntry
} from "./commands-doctor.js";

describe("conformal abstention calibration (muse doctor --calibration)", () => {
  it("parseAlpha clamps to (0,1), defaults 0.1 on bad input", () => {
    expect(parseAlpha("0.2")).toBe(0.2);
    expect(parseAlpha(undefined)).toBe(0.1);
    expect(parseAlpha("nope")).toBe(0.1);
    expect(parseAlpha("0")).toBe(0.1);
    expect(parseAlpha("1")).toBe(0.1);
    expect(parseAlpha("-0.3")).toBe(0.1);
  });

  it("buildCalibrationReport keeps answerable items (coverage ≥ target) and counts refuse items held below", () => {
    // answerable scores are HIGH (0.6-0.9), should-refuse scores are LOW (0.1-0.4).
    const positives = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.62, 0.78, 0.83];
    const negatives = [0.1, 0.2, 0.3, 0.4, 0.15];
    const report = buildCalibrationReport(positives, negatives, 0.1);
    expect(report.n).toBe(10);
    expect(report.calibrationCoverage).toBeGreaterThanOrEqual(report.targetCoverage);
    // a threshold tuned to the high answerable scores holds all the low refuse scores below it
    expect(report.refuseHeld).toBe(5);
    expect(report.refuseTotal).toBe(5);
  });

  it("formatCalibration renders an honest table, and an empty calibration set says so", () => {
    expect(formatCalibration([buildCalibrationReport([], [], 0.1)])).toContain("nothing to calibrate");
    const out = formatCalibration([buildCalibrationReport([0.6, 0.7, 0.8, 0.9, 0.65, 0.75, 0.85, 0.95, 0.62, 0.72], [0.2, 0.3], 0.1)]);
    expect(out).toContain("conformal");
    expect(out).toContain("0.10");
    expect(out).toMatch(/refuse-held/);
  });
});

describe("formatWeaknesses — the Whetstone ledger as an honest self-report", () => {
  it("renders an honest 'nothing yet' line for an empty ledger", () => {
    expect(formatWeaknesses([])).toContain("no weak spots recorded yet");
  });

  it("sorts busiest-first, labels the axis, and shows count + last day", () => {
    const out = formatWeaknesses([
      { axis: "grounding-gap", count: 1, firstSeen: "2026-06-01T00:00:00Z", lastSeen: "2026-06-01T00:00:00Z", topic: "vpn mtu" },
      { axis: "unbacked-action", count: 5, firstSeen: "2026-06-02T00:00:00Z", lastSeen: "2026-06-06T00:00:00Z", topic: "회의 일정" }
    ]);
    expect(out.indexOf("회의 일정")).toBeLessThan(out.indexOf("vpn mtu")); // higher count first
    expect(out).toContain("said it acted but didn't");
    expect(out).toContain("5×");
    expect(out).toContain("2026-06-06");
  });

  it("renders a hint line when present", () => {
    const out = formatWeaknesses([{ axis: "grounding-gap", count: 2, firstSeen: "2026-06-01T00:00:00Z", lastSeen: "2026-06-06T00:00:00Z", topic: "rent", hint: "ask the user to add a note" }]);
    expect(out).toContain("ask the user to add a note");
  });
});

describe("formatRunOutcomes — the failure-RATE the cumulative ledger lacks", () => {
  it("reports a fresh-start line when nothing is graded yet", () => {
    expect(formatRunOutcomes({ labelled: 0, grounded: 0, abstain: 0, ungrounded: 0, failRate: 0, topFailingTopics: [] }))
      .toContain("no graded runs yet");
  });

  it("renders the rate, the outcome breakdown, and the top failing topics", () => {
    const out = formatRunOutcomes({
      labelled: 4, grounded: 2, abstain: 1, ungrounded: 1, failRate: 0.5,
      topFailingTopics: [{ topic: "office vpn mtu", count: 2 }, { topic: "dentist", count: 1 }]
    });
    expect(out).toContain("4 graded runs");
    expect(out).toContain("fail-rate 50%");
    expect(out).toContain("2 grounded · 1 abstain · 1 ungrounded");
    expect(out).toContain("office vpn mtu (2×)");
    expect(out).toContain("dentist (1×)");
  });
});

describe("weaknessFuelCheck — surface dev-fixable fuel in the default doctor (informational)", () => {
  it("returns undefined when there's no fuel (plain doctor stays quiet)", () => {
    expect(weaknessFuelCheck([])).toBeUndefined();
  });
  it("is an OK (not warn/fail) info line counting the recurring agent bugs + the top one", () => {
    const check = weaknessFuelCheck([
      { topic: "calendar add silent fail", axis: "unbacked-action", count: 4 },
      { topic: "next friday wrong", axis: "time-parse", count: 3 }
    ]);
    expect(check?.status).toBe("ok"); // self-knowledge, not a health failure → won't flip doctor to warn
    expect(check?.name).toBe("weakness ledger");
    expect(check?.detail).toContain("2 recurring agent bugs");
    expect(check?.detail).toContain("calendar add silent fail (unbacked-action 4×)");
    expect(check?.detail).toContain("+1 more");
  });
});

describe("formatDevFixableWeaknesses — the dev loop's own-bug fix list", () => {
  it("is empty (no noise) when there are no dev-fixable bugs", () => {
    expect(formatDevFixableWeaknesses([])).toBe("");
  });
  it("lists each recurring agent bug with its axis + count", () => {
    const out = formatDevFixableWeaknesses([
      { topic: "calendar add silent fail", axis: "unbacked-action", count: 4 },
      { topic: "next friday wrong", axis: "time-parse", count: 3 }
    ]);
    expect(out).toContain("Recurring agent bugs");
    expect(out).toContain("calendar add silent fail  — unbacked-action (4×)");
    expect(out).toContain("next friday wrong  — time-parse (3×)");
  });
});

describe("episodeIndexHealth — are past sessions searchable by recall / today --connect", () => {
  it("ok (silent-friendly) when there are no episodes captured yet", () => {
    expect(episodeIndexHealth({ episodeCount: 0, indexedCount: 0 }).status).toBe("ok");
  });
  it("warns when episodes exist but none are indexed", () => {
    const v = episodeIndexHealth({ episodeCount: 5, indexedCount: 0 });
    expect(v.status).toBe("warn");
    expect(v.detail).toMatch(/episode reindex/i);
  });
  it("warns when the index lags behind captured episodes", () => {
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 2 }).status).toBe("warn");
  });
  it("ok when every episode is indexed", () => {
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 5 }).status).toBe("ok");
  });
});

describe("notesIndexHealth — does doctor see whether the second brain is searchable", () => {
  it("warns when no index exists yet (recall/ask/today --connect return nothing)", () => {
    const v = notesIndexHealth({ exists: false, stale: false });
    expect(v.status).toBe("warn");
    expect(v.detail).toMatch(/reindex/i);
  });
  it("warns when the index is stale (notes changed since last reindex)", () => {
    const v = notesIndexHealth({ exists: true, stale: true });
    expect(v.status).toBe("warn");
    expect(v.detail).toMatch(/stale|reindex/i);
  });
  it("ok when the index exists and is fresh", () => {
    const v = notesIndexHealth({ exists: true, stale: false });
    expect(v.status).toBe("ok");
  });
});

describe("findOllamaModelTag (goal 101)", () => {
  const models: readonly OllamaTagsEntry[] = [
    { name: "qwen3.5:9b-q4_K_M", size: 6_600_000_000 },
    { name: "qwen2.5:latest", size: 4_700_000_000 },
    { name: "nomic-embed-text:latest", size: 274_000_000 }
  ];

  it("matches an explicit tag verbatim", () => {
    expect(findOllamaModelTag(models, "qwen3.5:9b-q4_K_M")?.size).toBe(6_600_000_000);
  });

  it("treats `<base>` and `<base>:latest` as the same identity (Ollama default tag)", () => {
    expect(findOllamaModelTag(models, "qwen2.5")?.name).toBe("qwen2.5:latest");
    expect(findOllamaModelTag(models, "qwen2.5:latest")?.name).toBe("qwen2.5:latest");
  });

  it("returns undefined for an unpulled tag", () => {
    expect(findOllamaModelTag(models, "qwen3.6:27b")).toBeUndefined();
    expect(findOllamaModelTag(models, "llama4")).toBeUndefined();
  });

  it("trims whitespace on the configured tag (config files often carry stray newlines)", () => {
    expect(findOllamaModelTag(models, "  qwen3.5:9b-q4_K_M  ")?.size).toBe(6_600_000_000);
  });

  it("returns undefined for an empty model list (Ollama up but nothing pulled yet)", () => {
    expect(findOllamaModelTag([], "qwen3.5:9b-q4_K_M")).toBeUndefined();
  });

  it("does NOT match a different tag of the same base (q4 vs q8)", () => {
    expect(findOllamaModelTag(models, "qwen3.5:9b-q8_0")).toBeUndefined();
  });
});

describe("parseNotesIndexEmbedModel (goal 102)", () => {
  it("returns the recorded model when the index carries one", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "mxbai-embed-large", version: 1 })))
      .toBe("mxbai-embed-large");
  });

  it("falls back to the documented default when the field is missing", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ version: 1 }))).toBe("nomic-embed-text-v2-moe");
  });

  it("falls back to the default on malformed JSON (corrupt index)", () => {
    expect(parseNotesIndexEmbedModel("{ this is not json")).toBe("nomic-embed-text-v2-moe");
  });

  it("returns undefined when no file exists at all (user has not opted into RAG)", () => {
    expect(parseNotesIndexEmbedModel(undefined)).toBeUndefined();
  });

  it("trims whitespace and treats whitespace-only model as missing", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "  nomic-embed-text  " })))
      .toBe("nomic-embed-text");
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "   " }))).toBe("nomic-embed-text-v2-moe");
  });
});

describe("embedModelCheck (goal 168)", () => {
  it("ok + index-aware message when the indexed model is pulled", () => {
    const v = embedModelCheck("nomic-embed-text", true, 274_000_000);
    expect(v.status).toBe("ok");
    expect(v.detail).toContain("RAG over ~/notes works");
  });

  it("ok + reindex hint when pulled but no index exists yet", () => {
    const v = embedModelCheck("nomic-embed-text", false, 274_000_000);
    expect(v.status).toBe("ok");
    expect(v.detail).toContain("muse notes reindex");
  });

  it("warn + degrade wording when an index exists but the model is gone", () => {
    const v = embedModelCheck("mxbai-embed-large", true, undefined);
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("ollama pull mxbai-embed-large");
    expect(v.detail).toContain("degrade");
  });

  it("warn + unavailable wording when no index and the default isn't pulled", () => {
    const v = embedModelCheck("nomic-embed-text", false, undefined);
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("ollama pull nomic-embed-text");
    expect(v.detail).toContain("muse ask` unavailable");
  });
});

describe("classifyMcpServersField — surface mcp.json shape problems instead of silently reporting 'ok with 0 servers'", () => {
  it("returns 'ok' with the count when `servers` is a non-empty array", () => {
    expect(classifyMcpServersField({ servers: [{ name: "x" }] }))
      .toEqual({ detail: "1 server(s) registered", status: "ok" });
    expect(classifyMcpServersField({ servers: [{ name: "x" }, { name: "y" }, { name: "z" }] }))
      .toEqual({ detail: "3 server(s) registered", status: "ok" });
  });

  it("returns 'warn' when `servers` is an explicit empty array — file is well-formed, user just hasn't added any", () => {
    expect(classifyMcpServersField({ servers: [] }))
      .toEqual({ detail: "0 server(s) registered", status: "warn" });
  });

  it("returns 'warn' when the `servers` key is absent — pre-fix the doctor silently reported 'ok with 0 servers' instead of surfacing the missing key", () => {
    expect(classifyMcpServersField({}))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("no `servers` key") });
    expect(classifyMcpServersField({ otherSetting: "x" }))
      .toMatchObject({ status: "warn" });
  });

  it("returns 'fail' when `servers` exists but is the wrong shape — pre-fix `{servers: {foo: 'bar'}}` silently reported 'ok with 0 servers', masking a misconfiguration that would break MCP at runtime", () => {
    expect(classifyMcpServersField({ servers: { foo: "bar" } }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("must be an array") });
    expect(classifyMcpServersField({ servers: null }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("null") });
    expect(classifyMcpServersField({ servers: "stringy" }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("string") });
    expect(classifyMcpServersField({ servers: 42 }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("number") });
    expect(classifyMcpServersField({ servers: true }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("boolean") });
  });

  it("returns 'fail' when the JSON root is not an object (top-level array, string, null, number)", () => {
    expect(classifyMcpServersField(null)).toMatchObject({ status: "fail" });
    expect(classifyMcpServersField([])).toMatchObject({ status: "fail" });
    expect(classifyMcpServersField("not-an-object")).toMatchObject({ status: "fail" });
    expect(classifyMcpServersField(42)).toMatchObject({ status: "fail" });
  });
});

describe("classifyWebWatchConfig — surface silently-dropped web-watch entries instead of a quiet no-op", () => {
  const valid = (id: string, extra: Record<string, unknown> = {}) => ({
    id, url: "https://x.test", title: "t", message: "m", rule: { appears: "foo" }, ...extra
  });

  it("returns undefined when unset or an empty array (nothing to report)", () => {
    expect(classifyWebWatchConfig(undefined)).toBeUndefined();
    expect(classifyWebWatchConfig("")).toBeUndefined();
    expect(classifyWebWatchConfig("   ")).toBeUndefined();
    expect(classifyWebWatchConfig("[]")).toBeUndefined();
  });

  it("reports 'ok' with the count when every entry is valid", () => {
    expect(classifyWebWatchConfig(JSON.stringify([valid("a"), valid("b")])))
      .toMatchObject({ status: "ok", detail: expect.stringContaining("2 page-watch") });
  });

  it("counts a chrome-source entry as valid (not dropped for lack of a live browser here)", () => {
    expect(classifyWebWatchConfig(JSON.stringify([valid("a", { source: "chrome", rule: { onAnyChange: true } })])))
      .toMatchObject({ status: "ok", detail: expect.stringContaining("1 page-watch") });
  });

  it("warns and quantifies the drop when some entries are invalid", () => {
    const config = JSON.stringify([
      valid("a"),
      { id: "b", title: "t", message: "m", rule: { appears: "x" } }, // missing url
      { id: "c", url: "https://y.test", title: "t", message: "m", rule: {} } // rule has no condition
    ]);
    expect(classifyWebWatchConfig(config))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("2 of 3 web-watch entries are invalid") });
  });

  it("uses singular phrasing for a single dropped entry", () => {
    const config = JSON.stringify([valid("a"), { id: "b", title: "t", message: "m", rule: { appears: "x" } }]);
    expect(classifyWebWatchConfig(config))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("1 of 2 web-watch entry is invalid") });
  });

  it("warns when set but not valid JSON, or not a JSON array", () => {
    expect(classifyWebWatchConfig("{not json")).toMatchObject({ status: "warn", detail: expect.stringContaining("not valid JSON") });
    expect(classifyWebWatchConfig('{"id":"a"}')).toMatchObject({ status: "warn", detail: expect.stringContaining("must be a JSON array") });
  });
});

describe("classifyHomeAlertsConfig — surface silently-dropped home-alert entries (symmetric to web-watch)", () => {
  const valid = (entityId: string, extra: Record<string, unknown> = {}) => ({
    entityId, label: "Front door", alertStates: ["unlocked", "open"], ...extra
  });

  it("returns undefined when unset or an empty array (nothing to report)", () => {
    expect(classifyHomeAlertsConfig(undefined)).toBeUndefined();
    expect(classifyHomeAlertsConfig("")).toBeUndefined();
    expect(classifyHomeAlertsConfig("   ")).toBeUndefined();
    expect(classifyHomeAlertsConfig("[]")).toBeUndefined();
  });

  it("reports 'ok' with the count when every entry is valid", () => {
    expect(classifyHomeAlertsConfig(JSON.stringify([valid("lock.front"), valid("cover.garage")])))
      .toMatchObject({ status: "ok", detail: expect.stringContaining("2 home-alert") });
  });

  it("warns and quantifies the drop when some entries are invalid", () => {
    const config = JSON.stringify([
      valid("lock.front"),
      { label: "no entity", alertStates: ["open"] }, // missing entityId
      { entityId: "sensor.x", label: "no states", alertStates: [] } // empty alertStates
    ]);
    expect(classifyHomeAlertsConfig(config))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("2 of 3 home-alert entries are invalid") });
  });

  it("uses singular phrasing for a single dropped entry", () => {
    const config = JSON.stringify([valid("lock.front"), { label: "bad", alertStates: ["open"] }]);
    expect(classifyHomeAlertsConfig(config))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("1 of 2 home-alert entry is invalid") });
  });

  it("warns when set but not valid JSON, or not a JSON array", () => {
    expect(classifyHomeAlertsConfig("{not json")).toMatchObject({ status: "warn", detail: expect.stringContaining("not valid JSON") });
    expect(classifyHomeAlertsConfig('{"entityId":"x"}')).toMatchObject({ status: "warn", detail: expect.stringContaining("must be a JSON array") });
  });
});

describe("resolveMuseEnvPath (goal-478/481/482 sibling, doctor surface)", () => {
  it("falls back to the documented default when env is unset", () => {
    expect(resolveMuseEnvPath(undefined, "/home/u/.muse")).toBe("/home/u/.muse");
  });

  it("uses the env value when it is a non-empty trimmed path", () => {
    expect(resolveMuseEnvPath("/custom/muse-home", "/home/u/.muse")).toBe("/custom/muse-home");
  });

  it("trims surrounding whitespace from the env path", () => {
    expect(resolveMuseEnvPath("  /custom/muse-home  ", "/home/u/.muse")).toBe("/custom/muse-home");
  });

  it("treats an empty / whitespace-only env value as unset (the bug 482 fixed for userId, here for doctor paths)", () => {
    expect(resolveMuseEnvPath("", "/home/u/.muse")).toBe("/home/u/.muse");
    expect(resolveMuseEnvPath("   ", "/home/u/.muse")).toBe("/home/u/.muse");
  });
});

describe("modelEnvCheck — reports the model the runtime ACTUALLY uses (mirrors resolveDefaultModel)", () => {
  it("local-only (default) + an ambient cloud key ⇒ reports the LOCAL model, ok (NOT 'inferred from GEMINI')", () => {
    const check = modelEnvCheck({ MUSE_LOCAL_ONLY: "true", GEMINI_API_KEY: "k" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("gemma4:12b");
    expect(check.detail).toContain("ambient cloud keys ignored");
    expect(check.detail).not.toContain("inferred from GEMINI");
  });

  it("local-only is the DEFAULT (env unset) — still reports the local model, not a cloud key", () => {
    const check = modelEnvCheck({ GEMINI_API_KEY: "k" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("gemma4:12b");
  });

  it("explicit MUSE_LOCAL_ONLY=false + a cloud key ⇒ warn, inferred from that key", () => {
    const check = modelEnvCheck({ MUSE_LOCAL_ONLY: "false", GEMINI_API_KEY: "k" });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("inferred from GEMINI_API_KEY");
  });

  it("an explicit MUSE_MODEL is reported verbatim regardless of local-only", () => {
    expect(modelEnvCheck({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "ollama/llama3" }).detail).toBe("ollama/llama3");
  });

  it("no model + opt-out + no key ⇒ fail (chat/ask would fail)", () => {
    const check = modelEnvCheck({ MUSE_LOCAL_ONLY: "false" });
    expect(check.status).toBe("fail");
  });
});

describe("localOnlyCheck — local-only / no-cloud-egress posture", () => {
  it("ON + a local model ⇒ ok, egress blocked", () => {
    const check = localOnlyCheck({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "ollama/llama3.2" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("blocked");
  });

  it("ON + an EXPLICIT cloud model ⇒ fail with the runtime's own reason (previews the boot refusal)", () => {
    const check = localOnlyCheck({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "gemini/gemini-2.0-flash", GEMINI_API_KEY: "k" });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("MUSE_LOCAL_ONLY");
  });

  it("ON + an ambient cloud key but NO explicit model ⇒ ok (default resolves local)", () => {
    const check = localOnlyCheck({ MUSE_LOCAL_ONLY: "true", GEMINI_API_KEY: "k" });
    expect(check.status).toBe("ok");
  });

  it("explicit OFF (opt-out) + cloud credentials present ⇒ warn that egress is possible", () => {
    const check = localOnlyCheck({ MUSE_LOCAL_ONLY: "false", OPENAI_API_KEY: "k" });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("OPENAI_API_KEY");
    expect(check.detail).toContain("opt-out");
  });

  it("explicit OFF (opt-out) + no cloud credentials ⇒ ok (nothing to leak)", () => {
    const check = localOnlyCheck({ MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "ollama/llama3.2" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("off");
  });

  it("DEFAULT (unset MUSE_LOCAL_ONLY) ⇒ local-only ON, egress blocked", () => {
    const check = localOnlyCheck({ MUSE_MODEL: "ollama/llama3.2" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("default");
  });
});

describe("selfLearningCheck — verifiable autonomy (B1 §7)", () => {
  it("ON + daemon installed → ok 'will run while idle'", () => {
    const c = selfLearningCheck({ enabled: true, paused: false, installed: true });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("ON, will run while idle");
  });

  it("ON but daemon NOT installed → warn pointing at `muse daemon --install`", () => {
    const c = selfLearningCheck({ enabled: true, paused: false, installed: false });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("muse daemon --install");
  });

  it("paused → warn pointing at `muse playbook resume` (even if enabled+installed)", () => {
    const c = selfLearningCheck({ enabled: true, paused: true, installed: true });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("muse playbook resume");
  });

  it("OFF (default) → ok, explains how to enable", () => {
    const c = selfLearningCheck({ enabled: false, paused: false, installed: false });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("MUSE_IDLE_LEARNING_ENABLED");
  });
})
