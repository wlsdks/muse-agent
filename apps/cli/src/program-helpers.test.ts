import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest, ARGV_MAX_CHARS, assertArgvWithinLimit, buildAskRunLog, chatTurnPersistText, defaultConfigPath, firstNonEmpty, readConfigStore, readResponseGrounded, readResponseSuccess, setConfigValue, summarizeRetrieval, unsetConfigValue, writeConfigStore } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

describe("summarizeRetrieval + buildAskRunLog retrieval — 'why this answer' trace (P1.2)", () => {
  it("summarizeRetrieval keeps ASSEMBLY order (notes lead), top-K, prefers cosine, rounds", () => {
    // Order preserved on purpose: synthetic exact-match entries (constant 1.0) must
    // NOT be sorted above the real cosine notes that actually informed the answer.
    const out = summarizeRetrieval([
      { source: "vpn.md", cosine: 0.621345, score: 0.5 },
      { source: "net.md", cosine: 0.41, score: 0.41 },
      { source: "task: x", cosine: 1, score: 1 } // synthetic — would dominate if sorted
    ], 2);
    expect(out).toEqual([{ source: "vpn.md", score: 0.6213 }, { source: "net.md", score: 0.41 }]);
  });

  it("buildAskRunLog embeds retrieval in the trace response (readable by the analyzer / a future inspector)", () => {
    const entry = buildAskRunLog({
      query: "q", timings: {}, grounded: "grounded", response: "a", success: true, toolsUsed: [],
      retrieval: [{ source: "vpn.md", score: 0.62 }]
    });
    expect((entry.response as { retrieval?: unknown }).retrieval).toEqual([{ source: "vpn.md", score: 0.62 }]);
  });

  it("omits retrieval when absent (back-compat: no empty key)", () => {
    const entry = buildAskRunLog({ query: "q", timings: {}, grounded: "grounded", response: "a", success: true, toolsUsed: [] });
    expect((entry.response as Record<string, unknown>)).not.toHaveProperty("retrieval");
  });
});

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
});

describe("chatTurnPersistText — persist the cue-free chat turn, not the display string with source-check cues (grounded≠true: a cue must not become trusted evidence next session)", () => {
  it("prefers responseForHistory (cue-free) over the displayed response (with cue)", () => {
    const body = {
      response: "할 일은 보고서 작성 1건이에요\n\n⚠️ 출처 확인: tool-fetched 데이터에만 근거합니다.",
      responseForHistory: "할 일은 보고서 작성 1건이에요"
    };
    expect(chatTurnPersistText(body)).toBe("할 일은 보고서 작성 1건이에요");
    expect(chatTurnPersistText(body)).not.toContain("출처 확인");
  });

  it("falls back to response when no cue-free twin is supplied (remote/legacy paths)", () => {
    expect(chatTurnPersistText({ response: "plain answer" })).toBe("plain answer");
  });

  it("returns undefined when there's no usable string (caller skips the persist)", () => {
    expect(chatTurnPersistText({ response: 42 })).toBeUndefined();
    expect(chatTurnPersistText(null)).toBeUndefined();
    expect(chatTurnPersistText("not an object")).toBeUndefined();
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

  it("the ask failure-path payload (grounded:null, empty response/tools) traces as a failure carrying the error", () => {
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
    expect(defaultConfigPath()).toBe(join("/u/jinan", ".config", "muse", "config.json"));
  });

  it("honours an explicit non-empty `home` argument over HOME (trimmed)", () => {
    expect(defaultConfigPath("/elsewhere")).toBe(join("/elsewhere", ".config", "muse", "config.json"));
    expect(defaultConfigPath("  /trimmed  ")).toBe(join("/trimmed", ".config", "muse", "config.json"));
  });

  it("treats an empty / whitespace-only explicit `home` argument as unset and falls through to HOME", () => {
    expect(defaultConfigPath("")).toBe(join("/u/jinan", ".config", "muse", "config.json"));
    expect(defaultConfigPath("   ")).toBe(join("/u/jinan", ".config", "muse", "config.json"));
  });

  it("FAILS LOUD when HOME and os.homedir() both resolve to empty — config.json must NOT silently land at /.config/muse/... at the filesystem root", () => {
    vi.stubEnv("HOME", "");
    try {
      const resolved = defaultConfigPath().replaceAll("\\", "/");
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

describe("pruneRunLogDir — bound the unbounded run-log (retention)", () => {
  it("keeps the most-recent maxFiles, prunes the oldest, returns the prune count", async () => {
    const { mkdtempSync, writeFileSync, rmSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pruneRunLogDir } = await import("./program-helpers.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-runlog-"));
    try {
      for (const id of ["a", "b", "c", "d"]) {
        writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
        await new Promise((r) => setTimeout(r, 5)); // distinct mtimes (a oldest … d newest)
      }
      writeFileSync(join(dir, "notes.txt"), "x"); // non-jsonl is ignored
      const pruned = await pruneRunLogDir(dir, 2);
      expect(pruned).toBe(2); // a, b (oldest) removed
      const left = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
      expect(left).toEqual(["c.jsonl", "d.jsonl"]);
      expect(readdirSync(dir)).toContain("notes.txt"); // untouched
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("under the cap → no prune (returns 0); a missing dir → 0 (never throws)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pruneRunLogDir } = await import("./program-helpers.js");
    expect(await pruneRunLogDir("/no/such/runs/dir", 100)).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "muse-runlog-"));
    try {
      writeFileSync(join(dir, "a.jsonl"), "{}\n");
      expect(await pruneRunLogDir(dir, 100)).toBe(0);
      expect(await pruneRunLogDir(dir, 0)).toBe(0); // invalid cap → no-op
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("apiRequest — connection-refused hint (admin commands with no local mode: cost/traces/telemetry/analytics/tools stats/mcp list/settings/scheduler list)", () => {
  function connectionRefused(): Promise<Response> {
    const err = new Error("fetch failed") as Error & { cause?: unknown };
    err.cause = { code: "ECONNREFUSED" };
    return Promise.reject(err);
  }

  function freshIo(): ProgramIO {
    return {
      configDir: mkdtempSync(join(tmpdir(), "muse-apireq-")),
      fetch: connectionRefused as unknown as typeof fetch,
      stderr: () => undefined,
      stdout: () => undefined
    };
  }

  it("rejects with an actionable message (not a raw connection-refused stack) and never resolves", async () => {
    const io = freshIo();
    await expect(apiRequest(io, new Command(), "/api/admin/token-cost/daily")).rejects.toThrow(
      /Muse API server is not running.*pnpm --filter @muse\/api dev/su
    );
  });

  it("the hint never claims a --local fallback exists (misleading for commands that have none)", async () => {
    const io = freshIo();
    await expect(apiRequest(io, new Command(), "/api/admin/traces")).rejects.toThrowError();
    try {
      await apiRequest(io, new Command(), "/api/admin/traces");
      throw new Error("expected apiRequest to reject");
    } catch (error) {
      expect((error as Error).message).not.toMatch(/most commands support/iu);
    }
  });
});

describe("assertArgvWithinLimit — oversized-argv guard (Bug 1: a ~950k arg overflows Node's ESM entry into a raw 'Maximum call stack')", () => {
  it("returns the clean, actionable message (no stack trace) when the total argv length exceeds the limit", () => {
    const big = "a".repeat(ARGV_MAX_CHARS + 1);
    const msg = assertArgvWithinLimit(["node", "muse", "note", big]);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/^muse: input too large \(\d+ chars\)/u);
    expect(msg).toMatch(/pass large content via stdin/u);
    // The whole point: the user must NEVER see the raw V8 overflow.
    expect(msg).not.toMatch(/Maximum call stack/iu);
  });

  it("reports the accurate TOTAL char count across all argv entries, not just the trigger arg", () => {
    const half = "a".repeat(ARGV_MAX_CHARS);
    const msg = assertArgvWithinLimit([half, half]); // 2 * ARGV_MAX_CHARS exactly
    expect(msg).toContain(`(${(ARGV_MAX_CHARS * 2).toString()} chars)`);
  });

  it("returns null (proceed) for an ordinary argv well under the limit", () => {
    expect(assertArgvWithinLimit(["node", "muse", "note", "buy milk"])).toBeNull();
    expect(assertArgvWithinLimit([])).toBeNull();
  });

  it("is boundary-exact: == limit passes, limit+1 is rejected", () => {
    expect(assertArgvWithinLimit(["x".repeat(ARGV_MAX_CHARS)])).toBeNull();
    expect(assertArgvWithinLimit(["x".repeat(ARGV_MAX_CHARS + 1)])).not.toBeNull();
  });

  it("honours a custom maxChars (the injected threshold)", () => {
    expect(assertArgvWithinLimit(["abc"], 2)).toMatch(/input too large \(3 chars\)/u);
    expect(assertArgvWithinLimit(["ab"], 2)).toBeNull();
  });
});

describe("readConfigStore / writeConfigStore — atomic write + unreadable-path mapping (Bugs 2 & 3)", () => {
  function ioFor(configDir: string): ProgramIO {
    return { configDir, stderr: () => undefined, stdout: () => undefined } as unknown as ProgramIO;
  }

  it("writeConfigStore persists valid JSON at mode 0o600 that round-trips, leaving no .tmp litter (atomic tmp+rename)", async () => {
    const { mkdtempSync, rmSync, readdirSync, statSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "muse-cfgwrite-"));
    try {
      const io = ioFor(dir);
      await writeConfigStore(io, { apiUrl: "http://127.0.0.1:9999", defaultModel: "ollama/gemma4:12b" });
      const roundTripped = await readConfigStore(io);
      expect(roundTripped).toEqual({ apiUrl: "http://127.0.0.1:9999", defaultModel: "ollama/gemma4:12b" });

      expect(readdirSync(dir).some((n) => n.includes(".tmp-"))).toBe(false); // temp file renamed away, not left behind
      const mode = statSync(join(dir, "config.json")).mode & 0o777;
      if (process.platform !== "win32") expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("writeConfigStore cleans up its temp file when the rename target is unwritable (no partial litter left behind)", async () => {
    const { mkdtempSync, rmSync, mkdirSync, readdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "muse-cfgfail-"));
    try {
      // Make the destination a DIRECTORY so `rename(tmp, config.json)` fails: the write
      // must throw AND remove the tmp file it created (no partial-state litter).
      mkdirSync(join(dir, "config.json"), { recursive: true });
      const io = ioFor(dir);
      await expect(writeConfigStore(io, { apiUrl: "http://x" })).rejects.toThrow();
      expect(readdirSync(dir).some((n) => n.includes(".tmp-"))).toBe(false); // temp cleaned up on failure
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("readConfigStore maps EISDIR (config path is a directory) to a clean message naming the path — not a raw errno", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "muse-cfgdir-"));
    try {
      mkdirSync(join(dir, "config.json"), { recursive: true });
      const io = ioFor(dir);
      await expect(readConfigStore(io)).rejects.toThrow(/is not a readable file \(EISDIR\)/u);
      await expect(readConfigStore(io)).rejects.toThrow(/config\.json/u); // names the offending path
      // Never leaks the raw Node errno phrasing.
      await expect(readConfigStore(io)).rejects.not.toThrow(/illegal operation on a directory/u);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("readConfigStore still treats a missing file as an empty config (ENOENT unchanged)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "muse-cfgnone-"));
    try {
      expect(await readConfigStore(ioFor(dir))).toEqual({});
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
