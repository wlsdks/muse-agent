import { mkdtempSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  activeModelEnvOverride,
  fetchInstalledOllamaModels,
  readMuseCliConfigFile,
  resolveModelSwitchTarget,
  resolveOllamaBaseUrl,
  writeMuseCliDefaultModel
} from "./model-registry.js";
import { resolveMuseCliConfigFilePath } from "./provider-paths.js";
import type { MuseEnvironment } from "./index.js";

// R3-3 — every fetch here is INJECTED (never real Ollama, house rule: a
// vitest run must never touch the network) and every file write goes
// through an isolated tmp path (never the real ~/.config/muse/config.json).

function fakeTagsFetch(models: readonly { readonly name: string; readonly size?: number; readonly modified_at?: string }[], status = 200): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ models }), { status })) as unknown as typeof globalThis.fetch;
}

function throwingFetch(message = "ECONNREFUSED"): typeof globalThis.fetch {
  return (async () => { throw new Error(message); }) as unknown as typeof globalThis.fetch;
}

describe("fetchInstalledOllamaModels", () => {
  it("parses name/size/modified_at from /api/tags", async () => {
    const result = await fetchInstalledOllamaModels(
      "http://127.0.0.1:11434",
      fakeTagsFetch([{ modified_at: "2026-07-01T00:00:00Z", name: "gemma4:12b", size: 8_100_000_000 }])
    );
    expect(result).toEqual({
      models: [{ modifiedAt: "2026-07-01T00:00:00Z", name: "gemma4:12b", sizeBytes: 8_100_000_000 }],
      ok: true
    });
  });

  it("tolerates a missing size/modified_at (still returns the name)", async () => {
    const result = await fetchInstalledOllamaModels("http://127.0.0.1:11434", fakeTagsFetch([{ name: "qwen3:8b" }]));
    expect(result).toEqual({ models: [{ name: "qwen3:8b" }], ok: true });
  });

  it("returns ok:false on a non-2xx response (no throw)", async () => {
    const result = await fetchInstalledOllamaModels("http://127.0.0.1:11434", fakeTagsFetch([], 500));
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when the fetch itself throws (Ollama unreachable)", async () => {
    const result = await fetchInstalledOllamaModels("http://127.0.0.1:11434", throwingFetch());
    expect(result).toEqual({ error: "ECONNREFUSED", ok: false });
  });

  it("strips a trailing slash off baseUrl before hitting /api/tags", async () => {
    let requestedUrl = "";
    const capture: typeof globalThis.fetch = (async (input: string | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchInstalledOllamaModels("http://127.0.0.1:11434/", capture);
    expect(requestedUrl).toBe("http://127.0.0.1:11434/api/tags");
  });
});

describe("activeModelEnvOverride", () => {
  it("MUSE_MODEL wins when both are set", () => {
    expect(activeModelEnvOverride({ MUSE_DEFAULT_MODEL: "b", MUSE_MODEL: "a" })).toEqual({ key: "MUSE_MODEL", value: "a" });
  });

  it("falls back to the legacy MUSE_DEFAULT_MODEL", () => {
    expect(activeModelEnvOverride({ MUSE_DEFAULT_MODEL: "legacy" })).toEqual({ key: "MUSE_DEFAULT_MODEL", value: "legacy" });
  });

  it("undefined when neither is set (or only blank)", () => {
    expect(activeModelEnvOverride({})).toBeUndefined();
    expect(activeModelEnvOverride({ MUSE_MODEL: "   " })).toBeUndefined();
  });
});

describe("resolveOllamaBaseUrl", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-model-registry-keys-"));

  it("defaults to 127.0.0.1:11434 with no override", () => {
    expect(resolveOllamaBaseUrl({ MUSE_MODEL_KEYS_FILE: join(dir, "models.json") })).toBe("http://127.0.0.1:11434");
  });

  it("honours OLLAMA_BASE_URL, trailing slashes stripped", () => {
    expect(resolveOllamaBaseUrl({ MUSE_MODEL_KEYS_FILE: join(dir, "models.json"), OLLAMA_BASE_URL: "http://ollama.lan:11434/" }))
      .toBe("http://ollama.lan:11434");
  });

  it("refuses a remote Ollama URL before model commands can probe it under local-only", () => {
    expect(() => resolveOllamaBaseUrl({
      MUSE_LOCAL_ONLY: "true",
      MUSE_MODEL_KEYS_FILE: join(dir, "models.json"),
      OLLAMA_BASE_URL: "http://ollama.lan:11434"
    })).toThrow();
  });
});

describe("resolveModelSwitchTarget", () => {
  it("exact installed tag matches", async () => {
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b" }]),
      requestedModel: "gemma4:12b"
    });
    expect(result).toEqual({ modelId: "ollama/gemma4:12b", ok: true, tag: "gemma4:12b" });
  });

  it("accepts an ollama/<tag>-prefixed request the same as the bare tag", async () => {
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b" }]),
      requestedModel: "ollama/gemma4:12b"
    });
    expect(result.ok).toBe(true);
  });

  it("matches the bare name against an installed :latest tag, and vice versa", async () => {
    const a = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([{ name: "llama3.2:latest" }]),
      requestedModel: "llama3.2"
    });
    expect(a).toMatchObject({ ok: true, tag: "llama3.2:latest" });

    const b = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([{ name: "llama3.2" }]),
      requestedModel: "llama3.2:latest"
    });
    expect(b).toMatchObject({ ok: true, tag: "llama3.2" });
  });

  it("unreachable Ollama → reason unreachable, no model implied", async () => {
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: throwingFetch(),
      requestedModel: "gemma4:12b"
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "unreachable" });
  });

  it("unknown model → reason unknown, close-miss suggestion, capped installed sample", async () => {
    const installed = Array.from({ length: 15 }, (_, i) => ({ name: `model-${i.toString()}` }));
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([...installed, { name: "gemma4:12b" }]),
      requestedModel: "gemma4:12"
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unknown") throw new Error("expected reason:unknown");
    expect(result.suggestion).toBe("gemma4:12b");
    expect(result.installedSample.length).toBe(10);
  });

  it("unknown model with NOTHING installed → a distinct, actionable message (no suggestion)", async () => {
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([]),
      requestedModel: "gemma4:12b"
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unknown") throw new Error("expected reason:unknown");
    expect(result.suggestion).toBeUndefined();
    expect(result.message).toContain("ollama pull");
  });

  it("localOnly + a cloud provider spec → refused BEFORE any fetch call (reason cloud-refused)", async () => {
    let fetchCalled = false;
    const spy: typeof globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: spy,
      localOnly: true,
      requestedModel: "gemini/gemini-2.0-flash"
    });
    expect(result).toMatchObject({ ok: false, reason: "cloud-refused" });
    expect(fetchCalled).toBe(false);
  });

  it("localOnly + a bare Ollama tag → still validated normally (not refused)", async () => {
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b" }]),
      localOnly: true,
      requestedModel: "gemma4:12b"
    });
    expect(result.ok).toBe(true);
  });

  it("localOnly + an explicit ollama/<tag> spec → also not refused", async () => {
    const result = await resolveModelSwitchTarget({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fakeTagsFetch([{ name: "gemma4:12b" }]),
      localOnly: true,
      requestedModel: "ollama/gemma4:12b"
    });
    expect(result.ok).toBe(true);
  });
});

describe("readMuseCliConfigFile / writeMuseCliDefaultModel", () => {
  it("an absent file reads as {} (fresh install)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-model-registry-cfg-"));
    expect(await readMuseCliConfigFile(join(dir, "config.json"))).toEqual({});
  });

  it("write then read round-trips, and preserves an existing apiUrl untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-model-registry-cfg-"));
    const file = join(dir, "config.json");
    await writeMuseCliDefaultModel(file, "ollama/gemma4:12b");
    let config = await readMuseCliConfigFile(file);
    expect(config).toEqual({ defaultModel: "ollama/gemma4:12b" });

    // Simulate an existing apiUrl already present (as if the CLI wrote it).
    await writeMuseCliDefaultModel(file, "ollama/qwen3:8b");
    config = await readMuseCliConfigFile(file);
    expect(config.defaultModel).toBe("ollama/qwen3:8b");
  });

  it("preserves an apiUrl that predates the switch (read-merge-write, no collateral loss)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-model-registry-cfg-"));
    const file = join(dir, "config.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, `${JSON.stringify({ apiUrl: "http://api.example" })}\n`);
    await writeMuseCliDefaultModel(file, "ollama/gemma4:12b");
    expect(await readMuseCliConfigFile(file)).toEqual({ apiUrl: "http://api.example", defaultModel: "ollama/gemma4:12b" });
  });

  it("rejects a config file that isn't valid JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-model-registry-cfg-"));
    const file = join(dir, "config.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "not json");
    await expect(readMuseCliConfigFile(file)).rejects.toThrow(/not valid JSON/);
  });

  it("writes the file with 0600 permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-model-registry-cfg-"));
    const file = join(dir, "config.json");
    await writeMuseCliDefaultModel(file, "ollama/gemma4:12b");
    const { stat } = await import("node:fs/promises");
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("resolveMuseCliConfigFilePath — fail-close under vitest, distinct from ~/.muse/", () => {
  const realHome = userInfo().homedir;
  const isoHome = mkdtempSync(join(tmpdir(), "muse-cli-config-path-"));

  it("resolves to <home>/.config/muse/config.json under an isolated home", () => {
    expect(resolveMuseCliConfigFilePath({ HOME: isoHome } as MuseEnvironment)).toBe(join(isoHome, ".config", "muse", "config.json"));
  });

  it("throws when it would fall back to the genuine account home under vitest", () => {
    expect(() => resolveMuseCliConfigFilePath({ HOME: realHome } as MuseEnvironment)).toThrow(/test isolation/i);
    expect(() => resolveMuseCliConfigFilePath({ HOME: realHome } as MuseEnvironment)).toThrow(/MUSE_CLI_CONFIG_FILE/);
  });

  it("an explicit MUSE_CLI_CONFIG_FILE override wins, even pointed at the real home", () => {
    expect(resolveMuseCliConfigFilePath({ HOME: realHome, MUSE_CLI_CONFIG_FILE: "/custom/config.json" } as MuseEnvironment))
      .toBe("/custom/config.json");
  });
});

describe("resolveMuseCliConfigFilePath / apps/cli defaultConfigPath — same file, no drift", () => {
  it("agrees with the CLI's own <home>/.config/muse/config.json convention", () => {
    const someHome = homedir();
    const viaShared = resolveMuseCliConfigFilePath({ HOME: someHome } as MuseEnvironment);
    expect(viaShared.endsWith(join(".config", "muse", "config.json"))).toBe(true);
  });
});
