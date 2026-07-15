import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatInstalledModels,
  formatSwitchConfirmation,
  formatSwitchFailure,
  resolveCurrentDefaultModel,
  runModelList,
  runModelUse,
  type ModelCommandDeps
} from "./commands-model.js";
import type { ProgramIO } from "./program.js";

// R3-3: `muse model` — validated against what Ollama actually has installed.
// Every network call here is injected (never real Ollama, per the house
// "vitest guard against real network" rule) and every filesystem write goes
// through an isolated `io.configDir` temp dir (never the real
// ~/.config/muse/config.json).

function harness(): { readonly io: ProgramIO; readonly stdout: string[]; readonly stderr: string[]; readonly configFile: string } {
  const configDir = mkdtempSync(join(tmpdir(), "muse-model-cmd-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { configDir, stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) } as unknown as ProgramIO;
  return { configFile: join(configDir, "config.json"), io, stderr, stdout };
}

function fakeTagsFetch(models: readonly { readonly name: string; readonly size?: number; readonly modified_at?: string }[]): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ models }), { status: 200 })) as unknown as typeof globalThis.fetch;
}

function unreachableFetch(): typeof globalThis.fetch {
  return (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;
}

/** A fetch that fails the test if it's ever called — asserts a code path never reaches the network. */
function neverCalledFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("fetch must not be called on this path");
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("resolveCurrentDefaultModel", () => {
  it("env MUSE_MODEL wins over CLI config", () => {
    const result = resolveCurrentDefaultModel({ MUSE_MODEL: "ollama/qwen3:8b" }, "ollama/gemma4:12b");
    expect(result.model).toBe("ollama/qwen3:8b");
    expect(result.source).toContain("MUSE_MODEL");
  });

  it("legacy env MUSE_DEFAULT_MODEL also wins over CLI config", () => {
    const result = resolveCurrentDefaultModel({ MUSE_DEFAULT_MODEL: "ollama/qwen3:8b" }, "ollama/gemma4:12b");
    expect(result.model).toBe("ollama/qwen3:8b");
    expect(result.source).toContain("MUSE_DEFAULT_MODEL");
  });

  it("CLI config wins when no env is set", () => {
    const result = resolveCurrentDefaultModel({}, "ollama/gemma4:12b");
    expect(result.model).toBe("ollama/gemma4:12b");
    expect(result.source).toContain("CLI config");
  });

  it("falls back to the built-in default when neither env nor config is set", () => {
    const result = resolveCurrentDefaultModel({}, undefined);
    expect(result.model).toBe("ollama/gemma4:12b");
    expect(result.source).toContain("built-in default");
  });
});

describe("formatInstalledModels", () => {
  it("marks the current default with a star and lists size + modified date", () => {
    const out = formatInstalledModels(
      [{ modifiedAt: "2026-07-01T00:00:00Z", name: "gemma4:12b", sizeBytes: 8_100_000_000 }],
      { model: "ollama/gemma4:12b", source: "CLI config" }
    );
    expect(out).toContain("* gemma4:12b");
    expect(out).toContain("2026-07-01");
    expect(out).toContain("GB");
  });

  it("reports no models installed, no crash", () => {
    const out = formatInstalledModels([], { model: "ollama/gemma4:12b", source: "built-in default" });
    expect(out).toContain("No models installed");
  });
});

describe("formatSwitchFailure", () => {
  it("unknown model includes the suggestion and the installed sample", () => {
    const out = formatSwitchFailure({
      installedSample: ["gemma4:12b", "qwen3:8b"],
      message: "'gemma4:12' is not installed in Ollama at http://127.0.0.1:11434.",
      ok: false,
      reason: "unknown",
      suggestion: "gemma4:12b"
    });
    expect(out).toContain("Did you mean 'gemma4:12b'?");
    expect(out).toContain("gemma4:12b, qwen3:8b");
  });

  it("unreachable / cloud-refused just surface the message verbatim", () => {
    expect(formatSwitchFailure({ message: "unreachable msg", ok: false, reason: "unreachable" })).toBe("unreachable msg");
    expect(formatSwitchFailure({ message: "refused msg", ok: false, reason: "cloud-refused" })).toBe("refused msg");
  });
});

describe("formatSwitchConfirmation", () => {
  it("no env override — says new CLI runs pick it up immediately, plus the daemon caveat", () => {
    const out = formatSwitchConfirmation({ env: {}, newModelId: "ollama/qwen3:8b", oldModel: "ollama/gemma4:12b" });
    expect(out).toContain("ollama/gemma4:12b → ollama/qwen3:8b");
    expect(out).toMatch(/muse chat.*muse tui.*immediately/s);
    expect(out).toContain("does NOT change an already-running `muse daemon`");
  });

  it("env override present — warns the env var still wins", () => {
    const out = formatSwitchConfirmation({
      env: { MUSE_MODEL: "ollama/gemma4:12b" },
      newModelId: "ollama/qwen3:8b",
      oldModel: "ollama/gemma4:12b"
    });
    expect(out).toContain("MUSE_MODEL=ollama/gemma4:12b is set");
    expect(out).toContain("does NOT change an already-running `muse daemon`");
  });
});

describe("runModelList", () => {
  it("Ollama unreachable — actionable stderr message, exit 2, no model list printed", async () => {
    const h = harness();
    await runModelList(h.io, { env: {}, fetchImpl: unreachableFetch() });
    expect(process.exitCode).toBe(2);
    expect(h.stderr.join("")).toContain("not reachable");
    expect(h.stdout.join("")).toBe("");
  });

  it("reachable — prints the installed models and the current default + source", async () => {
    const h = harness();
    await runModelList(h.io, {
      env: {},
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b", size: 8_100_000_000 }])
    });
    expect(process.exitCode).toBeUndefined();
    expect(h.stdout.join("")).toContain("gemma4:12b");
    expect(h.stdout.join("")).toContain("Current default:");
  });
});

describe("runModelUse — AC3 safety invariants", () => {
  it("Ollama unreachable → no config write, actionable message, exit 2", async () => {
    const h = harness();
    await runModelUse(h.io, "gemma4:12b", { env: {}, fetchImpl: unreachableFetch() });
    expect(process.exitCode).toBe(2);
    expect(h.stderr.join("")).toContain("not reachable");
    expect(existsSync(h.configFile)).toBe(false);
  });

  it("unknown/misspelled model → no config write, exit 2, suggests the close match", async () => {
    const h = harness();
    await runModelUse(h.io, "gemma4:12", {
      env: {},
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b" }])
    });
    expect(process.exitCode).toBe(2);
    expect(existsSync(h.configFile)).toBe(false);
    expect(h.stderr.join("")).toContain("gemma4:12b");
  });

  it("MUSE_LOCAL_ONLY + a cloud model spec → refused BEFORE any network call, no config write", async () => {
    const h = harness();
    const deps: ModelCommandDeps = { env: { MUSE_LOCAL_ONLY: "true" }, fetchImpl: neverCalledFetch() };
    await runModelUse(h.io, "gemini/gemini-2.0-flash", deps);
    expect(process.exitCode).toBe(2);
    expect(existsSync(h.configFile)).toBe(false);
    expect(h.stderr.join("")).toContain("Refused");
    expect(h.stderr.join("")).toContain("MUSE_LOCAL_ONLY");
  });

  it("a valid installed model → writes the config, preserves unrelated keys (apiUrl), prints old → new", async () => {
    const h = harness();
    writeFileSync(h.configFile, `${JSON.stringify({ apiUrl: "http://example.test", defaultModel: "ollama/gemma4:12b" })}\n`);
    await runModelUse(h.io, "qwen3:8b", {
      env: {},
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b" }, { name: "qwen3:8b" }])
    });
    expect(process.exitCode).toBeUndefined();
    const written = JSON.parse(readFileSync(h.configFile, "utf8")) as { apiUrl?: string; defaultModel?: string };
    expect(written.defaultModel).toBe("ollama/qwen3:8b");
    expect(written.apiUrl).toBe("http://example.test");
    expect(h.stdout.join("")).toContain("ollama/gemma4:12b → ollama/qwen3:8b");
  });

  it("env-override case: MUSE_MODEL is set → the switch STILL writes config, but the reply says the env var currently wins", async () => {
    const h = harness();
    await runModelUse(h.io, "qwen3:8b", {
      env: { MUSE_MODEL: "ollama/gemma4:12b" },
      fetchImpl: fakeTagsFetch([{ name: "qwen3:8b" }])
    });
    expect(process.exitCode).toBeUndefined();
    const written = JSON.parse(readFileSync(h.configFile, "utf8")) as { defaultModel?: string };
    expect(written.defaultModel).toBe("ollama/qwen3:8b");
    expect(h.stdout.join("")).toContain("MUSE_MODEL=ollama/gemma4:12b is set");
  });

  it("accepts an already-prefixed ollama/<tag> request the same as the bare tag", async () => {
    const h = harness();
    await runModelUse(h.io, "ollama/qwen3:8b", {
      env: {},
      fetchImpl: fakeTagsFetch([{ name: "qwen3:8b" }])
    });
    expect(process.exitCode).toBeUndefined();
    const written = JSON.parse(readFileSync(h.configFile, "utf8")) as { defaultModel?: string };
    expect(written.defaultModel).toBe("ollama/qwen3:8b");
  });
});
