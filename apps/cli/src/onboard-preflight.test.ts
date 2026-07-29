import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerOnboardCommand } from "./commands-onboard.js";
import { collectOnboardPreflight, type OnboardPreflightFs } from "./onboard-preflight.js";
import type { ProgramIO } from "./program.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const directory = { isDirectory: () => true };
const file = { isDirectory: () => false };

function stableEntry(): { readonly entry: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "muse-onboard-preflight-cli-"));
  const entry = join(root, "dist", "index.js");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { muse: "./dist/index.js" }, name: "@muse/cli" }));
  writeFileSync(entry, "export {};\n");
  return { entry, root };
}

function cleanRootFs(root: string, parent = "/isolated"): OnboardPreflightFs {
  return {
    access: async (path) => {
      if (path === parent) return;
      throw errno("EACCES");
    },
    lstat: async (path) => {
      if (path === root) throw errno("ENOENT");
      if (path === parent) return directory;
      throw errno("ENOENT");
    }
  };
}

describe("collectOnboardPreflight", () => {
  it("accepts a clean isolated root without creating it and reports the local default", async () => {
    const { entry } = stableEntry();
    const root = "/isolated/.cache/muse";
    let accessCalls = 0;
    const fs: OnboardPreflightFs = {
      ...cleanRootFs(root, "/isolated/.cache"),
      access: async (path, mode) => {
        accessCalls += 1;
        expect(mode).toBeGreaterThan(0);
        if (path === "/isolated/.cache") return;
        throw errno("EACCES");
      }
    };
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: root },
      fileSystem: fs,
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({
      configuredProviders: [],
      model: "ollama/gemma4:12b",
      museHome: root,
      locality: "local",
      provider: "ollama",
      ready: true
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cli-entry", status: "ok" }),
      expect.objectContaining({ id: "muse-home", status: "ok" }),
      expect.objectContaining({ id: "model-provider", status: "ok" })
    ]));
    expect(accessCalls).toBe(1);
  });

  it.each([
    ["missing", ""],
    ["relative", "dist/index.js"]
  ])("rejects a %s CLI entry", async (_kind, cliEntry) => {
    const report = await collectOnboardPreflight({
      cliEntry,
      env: { MUSE_HOME: "/isolated/muse" },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === "cli-entry")).toMatchObject({ status: "action" });
  });

  it("rejects a temporary or test-output CLI entry through validateDaemonCliEntry", async () => {
    const { entry, root } = stableEntry();
    const temporary = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: "/isolated/muse" },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: [root]
    });
    expect(temporary.checks.find((check) => check.id === "cli-entry")?.detail).toContain("temporary directory");

    const testRoot = mkdtempSync(join(tmpdir(), "muse-onboard-preflight-test-"));
    const testEntry = join(testRoot, "dist", "index.test.js");
    mkdirSync(join(testRoot, "dist"), { recursive: true });
    writeFileSync(join(testRoot, "package.json"), JSON.stringify({ bin: { muse: "./dist/index.test.js" }, name: "@muse/cli" }));
    writeFileSync(testEntry, "export {};\n");
    const unstable = await collectOnboardPreflight({
      cliEntry: testEntry,
      env: { MUSE_HOME: "/isolated/muse" },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(unstable.checks.find((check) => check.id === "cli-entry")?.detail).toContain("test output");
  });

  it.each([
    ["unwritable", {
      access: async () => { throw errno("EACCES"); },
      lstat: async () => directory
    } satisfies OnboardPreflightFs, "cannot be inspected or written"],
    ["non-directory", {
      access: async () => undefined,
      lstat: async () => file
    } satisfies OnboardPreflightFs, "exists but is not a directory"]
  ])("rejects a %s MUSE_HOME", async (_kind, fileSystem, detail) => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({ cliEntry: entry, env: { MUSE_HOME: "/isolated/muse" }, fileSystem, platform: "darwin", temporaryRoots: [] });
    expect(report.checks.find((check) => check.id === "muse-home")).toMatchObject({ detail: expect.stringContaining(detail), status: "action" });
  });

  it("rejects a cloud-synced MUSE_HOME without touching the filesystem", async () => {
    const { entry } = stableEntry();
    let touched = false;
    const fs: OnboardPreflightFs = {
      access: async () => { touched = true; },
      lstat: async () => { touched = true; return directory; }
    };
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: "/Users/me/Library/CloudStorage/Dropbox/muse" },
      fileSystem: fs,
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report.checks.find((check) => check.id === "muse-home")).toMatchObject({ status: "action" });
    expect(touched).toBe(false);
  });

  it("reports configured provider names and never serializes credential values", async () => {
    const { entry } = stableEntry();
    const marker = "never-serialize-this-secret";
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: "/isolated/muse", MUSE_LOCAL_ONLY: "false", OPENAI_API_KEY: marker },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["openai"], provider: "openai" });
    expect(JSON.stringify(report)).not.toContain(marker);
  });

  it("uses the runtime-resolved cloud model and provider when an ambient key wins", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: {
        GEMINI_API_KEY: "credential-value-never-reported",
        MUSE_CLI_CONFIG_FILE: "/isolated/missing-config.json",
        MUSE_HOME: "/isolated/muse",
        MUSE_LOCAL_ONLY: "false"
      },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["gemini"], model: "gemini/gemini-2.0-flash", provider: "gemini" });
    expect(report.checks.find((check) => check.id === "model-provider")?.detail).toContain("resolves to active cloud provider gemini");
    expect(JSON.stringify(report)).not.toContain("credential-value-never-reported");
  });

  it("keeps the local runtime model when local-only ignores ambient cloud keys", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: {
        GEMINI_API_KEY: "credential-value-never-reported",
        MUSE_CLI_CONFIG_FILE: "/isolated/missing-config.json",
        MUSE_HOME: "/isolated/muse",
        MUSE_LOCAL_ONLY: "true"
      },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["gemini"], model: "ollama/gemma4:12b", provider: "ollama" });
    expect(report.checks.find((check) => check.id === "model-provider")?.detail).toContain("resolves to active local provider ollama; configured provider names: gemini");
    expect(JSON.stringify(report)).not.toContain("credential-value-never-reported");
  });

  it("does not let an ambient cloud key contradict a saved active model", async () => {
    const { entry } = stableEntry();
    const configRoot = mkdtempSync(join(tmpdir(), "muse-onboard-preflight-config-"));
    const configFile = join(configRoot, "config.json");
    writeFileSync(configFile, JSON.stringify({ defaultModel: "ollama/gemma4:12b" }));
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: {
        GEMINI_API_KEY: "credential-value-never-reported",
        MUSE_CLI_CONFIG_FILE: configFile,
        MUSE_HOME: "/isolated/muse",
        MUSE_LOCAL_ONLY: "false"
      },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["gemini"], model: "ollama/gemma4:12b", provider: "ollama" });
    expect(report.checks.find((check) => check.id === "model-provider")?.detail).toContain("resolves to active local provider ollama; configured provider names: gemini");
    expect(JSON.stringify(report)).not.toContain("credential-value-never-reported");
  });

  it("calls an Ollama base URL a configured provider, never a credential", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: {
        MUSE_HOME: "/isolated/muse",
        MUSE_LOCAL_ONLY: "true",
        OLLAMA_BASE_URL: "http://127.0.0.1:11434/never-serialize-this-url"
      },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    const detail = report.checks.find((check) => check.id === "model-provider")?.detail ?? "";
    expect(report).toMatchObject({ configuredProviders: ["ollama"], provider: "ollama" });
    expect(detail).toContain("active local provider ollama; configured provider names: ollama");
    expect(detail.toLowerCase()).not.toContain("credential");
    expect(JSON.stringify(report)).not.toContain("never-serialize-this-url");
  });

  it("uses the authoritative openai-compatible/local runtime projection for a custom loopback model", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: {
        MUSE_HOME: "/isolated/muse",
        MUSE_MODEL: "custom/model",
        MUSE_MODEL_BASE_URL: "http://127.0.0.1:12345/v1"
      },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["openai-compatible"], locality: "local", model: "custom/model", provider: "openai-compatible" });
  });

  it("uses an explicitly configured diagnostic runtime provider", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: "/isolated/muse", MUSE_MODEL_PROVIDER_ID: "diagnostic" },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["diagnostic"], provider: "diagnostic" });
  });

  it("recognises GOOGLE_API_KEY as configured Gemini and reports its cloud locality", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: {
        GOOGLE_API_KEY: "credential-value-never-reported",
        MUSE_CLI_CONFIG_FILE: "/isolated/google-missing-config.json",
        MUSE_HOME: "/isolated/muse",
        MUSE_LOCAL_ONLY: "false"
      },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report).toMatchObject({ configuredProviders: ["gemini"], locality: "cloud", provider: "gemini" });
    expect(JSON.stringify(report)).not.toContain("credential-value-never-reported");
  });

  it("fails closed when the authoritative runtime provider rejects local-only configuration", async () => {
    const { entry } = stableEntry();
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: "/isolated/muse", MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "gemini/gemini-2.0-flash" },
      fileSystem: cleanRootFs("/isolated/muse"),
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report.ready).toBe(false);
    expect(report.provider).toBeUndefined();
    expect(report.checks.find((check) => check.id === "model-provider")).toMatchObject({ status: "action" });
  });

  it.each(["/tmp/muse", "/private/tmp/muse", "/var/tmp/muse", "/active/tmp/muse"])("rejects Darwin temporary MUSE_HOME %s before filesystem access", async (museHome) => {
    const { entry } = stableEntry();
    let touched = false;
    const report = await collectOnboardPreflight({
      cliEntry: entry,
      env: { MUSE_HOME: museHome },
      fileSystem: {
        access: async () => { touched = true; },
        lstat: async () => { touched = true; return directory; }
      },
      museHomeTemporaryRoots: ["/tmp", "/private/tmp", "/var/tmp", "/active/tmp"],
      platform: "darwin",
      temporaryRoots: []
    });
    expect(report.checks.find((check) => check.id === "muse-home")).toMatchObject({ detail: expect.stringContaining("temporary directory"), status: "action" });
    expect(touched).toBe(false);
  });

  it("branches before language, fetch, prompts, or daemon installation and emits JSON only", async () => {
    const { entry } = stableEntry();
    const output: string[] = [];
    const io: ProgramIO = {
      fetch: (() => { throw new Error("fetch must not run"); }) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (line) => output.push(line)
    };
    const program = new Command();
    registerOnboardCommand(program, io, {
      confirm: async () => { throw new Error("prompt must not run"); },
      confirmNotifications: async () => { throw new Error("prompt must not run"); },
      selectLanguage: async () => { throw new Error("language write path must not run"); },
      preflight: {
        cliEntry: entry,
        env: { MUSE_HOME: "/isolated/muse", OPENAI_API_KEY: "marker-secret" },
        fileSystem: cleanRootFs("/isolated/muse"),
        platform: "darwin",
        temporaryRoots: []
      },
      runLaunchctl: async () => { throw new Error("daemon install must not run"); }
    });
    await program.parseAsync(["node", "muse", "onboard", "--preflight", "--json"]);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("marker-secret");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ schemaVersion: "muse.onboard-preflight/v1" });
  });
});
