import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codexConfigPath,
  codexSetupSteps,
  detectCodexReadiness,
  readCodexDelegationConfig,
  runCodexExec,
  writeCodexDelegationConfig,
  type SpawnLike
} from "./codex-cli.js";

describe("detectCodexReadiness — CLI on PATH + logged-in probe", () => {
  it("ready when codex resolves on PATH AND auth.json exists", async () => {
    const readiness = await detectCodexReadiness({
      fileExists: (p) => p.endsWith(join(".codex", "auth.json")),
      home: "/home/u",
      which: async (cmd) => (cmd === "codex" ? "/usr/local/bin/codex" : undefined)
    });
    expect(readiness).toMatchObject({
      authFile: "/home/u/.codex/auth.json",
      cliOnPath: true,
      cliPath: "/usr/local/bin/codex",
      loggedIn: true,
      ready: true
    });
  });

  it("not ready when the CLI is missing (even if an auth file exists)", async () => {
    const readiness = await detectCodexReadiness({
      fileExists: () => true,
      home: "/home/u",
      which: async () => undefined
    });
    expect(readiness.cliOnPath).toBe(false);
    expect(readiness.ready).toBe(false);
  });

  it("not ready when the CLI is present but not logged in", async () => {
    const readiness = await detectCodexReadiness({
      fileExists: () => false,
      home: "/home/u",
      which: async () => "/usr/local/bin/codex"
    });
    expect(readiness.cliOnPath).toBe(true);
    expect(readiness.loggedIn).toBe(false);
    expect(readiness.ready).toBe(false);
  });
});

describe("codexSetupSteps — names the exact missing step", () => {
  it("tells the user to install AND login when both are missing", () => {
    const steps = codexSetupSteps({ authFile: "/h/.codex/auth.json", cliOnPath: false, loggedIn: false, ready: false });
    expect(steps).toContain("Install the official Codex CLI");
    expect(steps).toContain("codex login");
    expect(steps).toContain("muse setup start");
  });

  it("only asks for login when the CLI is already installed", () => {
    const steps = codexSetupSteps({ authFile: "/h/.codex/auth.json", cliOnPath: true, loggedIn: false, ready: false });
    expect(steps).not.toContain("Install the official Codex CLI");
    expect(steps).toContain("codex login");
  });
});

function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number; error?: Error }): { spawn: SpawnLike; calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ args, cmd });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    queueMicrotask(() => {
      if (opts.error) {
        child.emit("error", opts.error);
        return;
      }
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.code ?? 0);
    });
    return child;
  }) as unknown as SpawnLike;
  return { calls, spawn };
}

describe("runCodexExec — subprocess bridge scaffold (contract-faithful fake)", () => {
  it("invokes `codex exec <prompt>` and returns trimmed stdout on exit 0", async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, stdout: "  hello from codex  \n" });
    const result = await runCodexExec("say hi", { spawn });
    expect(calls[0]).toEqual({ args: ["exec", "say hi"], cmd: "codex" });
    expect(result).toMatchObject({ exitCode: 0, ok: true, text: "hello from codex" });
  });

  it("reports failure (ok=false) with stderr on a non-zero exit", async () => {
    const { spawn } = fakeSpawn({ code: 1, stderr: "not logged in" });
    const result = await runCodexExec("say hi", { spawn });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("not logged in");
  });

  it("resolves ok=false when the process cannot spawn", async () => {
    const { spawn } = fakeSpawn({ error: new Error("ENOENT codex") });
    const result = await runCodexExec("say hi", { spawn });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("ENOENT codex");
  });
});

describe("codex delegation config — write/read roundtrip", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "muse-codex-"));
  });
  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  it("writes an honest codex marker (delegated:true, live:false) and reads it back", async () => {
    const file = await writeCodexDelegationConfig(home, new Date("2026-07-08T00:00:00Z"));
    expect(file).toBe(codexConfigPath(home));
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toMatchObject({ delegated: true, live: false, provider: "codex" });
    const parsed = await readCodexDelegationConfig(home);
    expect(parsed).toMatchObject({ delegated: true, live: false, provider: "codex" });
  });

  it("returns undefined when no codex config exists", async () => {
    await rm(home, { force: true, recursive: true });
    expect(await readCodexDelegationConfig(home)).toBeUndefined();
  });
});
