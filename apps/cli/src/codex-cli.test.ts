import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCodexModelToEnv,
  codexConfigPath,
  codexSetupSteps,
  detectCodexReadiness,
  readCodexDelegationConfig,
  resolveCodexActivation,
  runCodexExec,
  writeCodexDelegationConfig,
  type SpawnLike
} from "./codex-cli.js";

describe.skipIf(process.platform === "win32")("detectCodexReadiness — CLI on PATH + logged-in probe", () => {
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

/**
 * Contract-faithful fake for the shared safe invocation: it extracts the `-o
 * <outfile>` path from the argv and writes the canned answer there (exactly like
 * the real `codex exec -o`), so the read-from-file extraction path is exercised.
 */
function fakeSpawn(opts: { output?: string; stderr?: string; code?: number; error?: Error }): { spawn: SpawnLike; calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ args, cmd });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    queueMicrotask(() => {
      void (async () => {
        if (opts.error) {
          child.emit("error", opts.error);
          return;
        }
        if ((opts.code ?? 0) === 0) {
          const oIdx = args.indexOf("-o");
          const outFile = oIdx >= 0 ? args[oIdx + 1] : undefined;
          if (outFile) await writeFile(outFile, opts.output ?? "");
        }
        if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
        child.emit("close", opts.code ?? 0);
      })();
    });
    return child;
  }) as unknown as SpawnLike;
  return { calls, spawn };
}

describe("runCodexExec — shared safe invocation (contract-faithful fake)", () => {
  it("uses the verified-safe argv and returns the -o file content on exit 0", async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, output: "  hello from codex  \n" });
    const result = await runCodexExec("say hi", { spawn, model: "gpt-5.1" });
    const args = calls[0]!.args;
    for (const flag of ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "-o", "-m"]) {
      expect(args, flag).toContain(flag);
    }
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.1");
    expect(args[args.length - 1]).toBe("say hi");
    expect(result).toMatchObject({ exitCode: 0, ok: true, text: "hello from codex" });
  });

  it("reports failure (ok=false) with a login hint on a non-zero exit", async () => {
    const { spawn } = fakeSpawn({ code: 1, stderr: "not logged in" });
    const result = await runCodexExec("say hi", { spawn });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("codex login");
  });

  it("resolves ok=false when the process cannot spawn", async () => {
    const { spawn } = fakeSpawn({ error: new Error("ENOENT codex") });
    const result = await runCodexExec("say hi", { spawn });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("ENOENT codex");
  });
});

describe("resolveCodexActivation — opt-in, readiness is the truth", () => {
  it("returns undefined when delegation was never configured (local default untouched)", async () => {
    const activation = await resolveCodexActivation({
      home: "/home/u",
      readConfig: async () => undefined,
      detect: async () => ({ authFile: "", cliOnPath: true, loggedIn: true, ready: true })
    });
    expect(activation).toBeUndefined();
  });

  it("active with a codex/<model> id when configured AND ready", async () => {
    const activation = await resolveCodexActivation({
      home: "/home/u",
      readConfig: async () => ({ configuredAt: "", delegated: true, model: "gpt-5.1", provider: "codex" }),
      detect: async () => ({ authFile: "", cliOnPath: true, loggedIn: true, ready: true })
    });
    expect(activation).toMatchObject({ active: true, configured: true, model: "codex/gpt-5.1" });
  });

  it("NOT active (with setup steps) when configured but the CLI is not ready", async () => {
    const activation = await resolveCodexActivation({
      home: "/home/u",
      readConfig: async () => ({ configuredAt: "", delegated: true, provider: "codex" }),
      detect: async () => ({ authFile: "/h/.codex/auth.json", cliOnPath: true, loggedIn: false, ready: false })
    });
    expect(activation?.active).toBe(false);
    expect(activation?.setupSteps).toContain("codex login");
    expect(activation?.model).toBeUndefined();
  });
});

describe("applyCodexModelToEnv — pins codex only when not already chosen", () => {
  it("sets MUSE_MODEL + provider id on a fresh env", () => {
    const env: { MUSE_MODEL?: string; MUSE_MODEL_PROVIDER_ID?: string } = {};
    expect(applyCodexModelToEnv(env, "codex/gpt-5.1")).toBe("codex/gpt-5.1");
    expect(env).toEqual({ MUSE_MODEL: "codex/gpt-5.1", MUSE_MODEL_PROVIDER_ID: "codex" });
  });

  it("leaves an explicitly-pinned MUSE_MODEL untouched", () => {
    const env = { MUSE_MODEL: "ollama/gemma4:12b" };
    expect(applyCodexModelToEnv(env, "codex/gpt-5.1")).toBeUndefined();
    expect(env.MUSE_MODEL).toBe("ollama/gemma4:12b");
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

  it("writes an honest codex marker (delegated:true) with an optional pinned model and reads it back", async () => {
    const file = await writeCodexDelegationConfig(home, new Date("2026-07-08T00:00:00Z"), "gpt-5.1");
    expect(file).toBe(codexConfigPath(home));
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toMatchObject({ delegated: true, model: "gpt-5.1", provider: "codex" });
    expect(raw.live).toBeUndefined();
    const parsed = await readCodexDelegationConfig(home);
    expect(parsed).toMatchObject({ delegated: true, model: "gpt-5.1", provider: "codex" });
  });

  it("returns undefined when no codex config exists", async () => {
    await rm(home, { force: true, recursive: true });
    expect(await readCodexDelegationConfig(home)).toBeUndefined();
  });
});
