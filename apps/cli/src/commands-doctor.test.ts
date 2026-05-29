import { describe, expect, it } from "vitest";

import {
  classifyHomeAlertsConfig,
  classifyMcpServersField,
  classifyWebWatchConfig,
  embedModelCheck,
  episodeIndexHealth,
  findOllamaModelTag,
  localOnlyCheck,
  notesIndexHealth,
  parseNotesIndexEmbedModel,
  resolveMuseEnvPath,
  type OllamaTagsEntry
} from "./commands-doctor.js";

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
    expect(parseNotesIndexEmbedModel(JSON.stringify({ version: 1 }))).toBe("nomic-embed-text");
  });

  it("falls back to the default on malformed JSON (corrupt index)", () => {
    expect(parseNotesIndexEmbedModel("{ this is not json")).toBe("nomic-embed-text");
  });

  it("returns undefined when no file exists at all (user has not opted into RAG)", () => {
    expect(parseNotesIndexEmbedModel(undefined)).toBeUndefined();
  });

  it("trims whitespace and treats whitespace-only model as missing", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "  nomic-embed-text  " })))
      .toBe("nomic-embed-text");
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "   " }))).toBe("nomic-embed-text");
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
