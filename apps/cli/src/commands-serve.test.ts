import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCliLanguage } from "./cli-i18n.js";
import { registerServeCommand, type ServeHelpers } from "./commands-serve.js";
import type { ServeChildHandle, ServeSpawnFn } from "./commands-serve-core.js";

import type { ProgramIO } from "./program.js";

setCliLanguage("en");

const REPO_ROOT = "/repo";
const DIST_ENTRY = join(REPO_ROOT, "apps", "api", "dist", "index.js");

function fakeRepoFs(opts: { readonly distExists?: boolean; readonly gitRepo?: boolean } = {}) {
  const distExists = opts.distExists ?? true;
  const gitRepo = opts.gitRepo ?? true;
  return {
    entry: join(REPO_ROOT, "node_modules", ".bin", "muse"),
    existsSync: (path: string) => {
      if (path === join(REPO_ROOT, "pnpm-workspace.yaml")) return true;
      if (path === join(REPO_ROOT, ".git")) return gitRepo;
      if (path === DIST_ENTRY) return distExists;
      return false;
    },
    realpathSync: (path: string) => path
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function connectionRefused(): Promise<Response> {
  const err = new Error("fetch failed") as Error & { cause?: unknown };
  err.cause = { code: "ECONNREFUSED" };
  return Promise.reject(err);
}

function noopSpawn(child: ServeChildHandle): ServeSpawnFn {
  return () => child;
}

function immediateExitChild(code: number | null = 0): ServeChildHandle {
  return { kill: () => undefined, pid: 111, waitForExit: async () => code };
}

async function runServe(
  args: readonly string[],
  overrides: ServeHelpers & { readonly fetchImpl?: typeof globalThis.fetch } = {}
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: ProgramIO = {
    fetch: overrides.fetchImpl,
    stderr: (m) => stderr.push(m),
    stdout: (m) => stdout.push(m)
  };
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerServeCommand(program, io, overrides);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", "serve", ...args]);
    exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (cause) {
    exitCode = (cause as { readonly exitCode?: number }).exitCode ?? 1;
  } finally {
    process.exitCode = prevExit;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("muse serve — foreground (AC1/AC4)", () => {
  it("fails closed outside a git checkout — nothing spawned, no fetch attempted", async () => {
    const fetchImpl = vi.fn();
    const { stderr, exitCode } = await runServe([], { ...fakeRepoFs({ gitRepo: false }), fetchImpl });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("can't self-manage a server");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tells the user to run `muse update` when apps/api/dist is missing — nothing spawned", async () => {
    const fetchImpl = vi.fn();
    const { stderr, exitCode } = await runServe([], { ...fakeRepoFs({ distExists: false }), fetchImpl });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("muse update");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("spawns on a free port with the discovered dist entry + resolved PORT/HOST", async () => {
    const spawnCalls: Parameters<ServeSpawnFn>[0][] = [];
    const spawn: ServeSpawnFn = (call) => {
      spawnCalls.push(call);
      return immediateExitChild(0);
    };
    const { stdout, exitCode } = await runServe(["--port", "4321"], {
      ...fakeRepoFs(),
      env: () => ({}),
      fetchImpl: connectionRefused as unknown as typeof globalThis.fetch,
      spawn
    });
    expect(exitCode).toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual([DIST_ENTRY]);
    expect(spawnCalls[0]?.cwd).toBe(REPO_ROOT);
    expect(spawnCalls[0]?.env.PORT).toBe("4321");
    expect(spawnCalls[0]?.env.HOST).toBe("127.0.0.1");
    expect(stdout).toContain("Starting the Muse API server");
  });

  it("never spawns a second server when a SAME-build server is already healthy", async () => {
    const spawn = vi.fn(noopSpawn(immediateExitChild()));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pid: 555, startedAtIso: "2026-07-14T00:00:00.000Z", version: "abc123" }));
    const { stdout, exitCode } = await runServe([], {
      ...fakeRepoFs(),
      env: () => ({ MUSE_BUILD_ID: "abc123" }),
      fetchImpl,
      spawn
    });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("already running");
    expect(stdout).toContain("pid 555");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dev-vs-dev (no MUSE_BUILD_ID either side) is treated as SAME and notes the honest limitation", async () => {
    const spawn = vi.fn(noopSpawn(immediateExitChild()));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pid: 1, startedAtIso: "t", version: "dev" }));
    const { stdout, exitCode } = await runServe([], { ...fakeRepoFs(), env: () => ({}), fetchImpl, spawn });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("can't tell dev builds apart");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a DIFFERENT build without --replace refuses and NEVER calls /api/admin/shutdown", async () => {
    const spawn = vi.fn(noopSpawn(immediateExitChild()));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pid: 1, startedAtIso: "t", version: "old-build" }));
    const { stderr, exitCode } = await runServe([], { ...fakeRepoFs(), env: () => ({ MUSE_BUILD_ID: "new-build" }), fetchImpl, spawn });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--replace");
    expect(spawn).not.toHaveBeenCalled();
    const shutdownCalls = fetchImpl.mock.calls.filter((call) => String(call[0]).includes("/api/admin/shutdown"));
    expect(shutdownCalls).toHaveLength(0);
  });

  it("a non-Muse port occupant fails closed even WITH --replace — zero shutdown attempts, never spawns", async () => {
    const spawn = vi.fn(noopSpawn(immediateExitChild()));
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>nope</html>", { headers: { "content-type": "text/html" }, status: 404 }));
    const { stderr, exitCode } = await runServe(["--replace"], { ...fakeRepoFs(), env: () => ({}), fetchImpl, spawn });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("doesn't look like the Muse API");
    expect(spawn).not.toHaveBeenCalled();
    const shutdownCalls = fetchImpl.mock.calls.filter((call) => String(call[0]).includes("/api/admin/shutdown"));
    expect(shutdownCalls).toHaveLength(0);
  });

  it("--replace against a different build shuts it down, waits for free, then spawns", async () => {
    const spawn = vi.fn(noopSpawn(immediateExitChild()));
    let healthCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/admin/shutdown")) return jsonResponse({ shuttingDown: true, version: "old-build" });
      healthCalls += 1;
      if (healthCalls === 1) return jsonResponse({ pid: 1, startedAtIso: "t", version: "old-build" });
      return connectionRefused();
    });
    const { stdout, exitCode } = await runServe(["--replace"], {
      ...fakeRepoFs(),
      env: () => ({ MUSE_BUILD_ID: "new-build" }),
      fetchImpl,
      sleep: async () => undefined,
      spawn
    });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("Replacing the running server");
    expect(spawn).toHaveBeenCalledTimes(1);
    const shutdownCalls = fetchImpl.mock.calls.filter((call) => String(call[0]).includes("/api/admin/shutdown"));
    expect(shutdownCalls).toHaveLength(1);
  });

  it("SIGINT (via the injected registrar) forwards a real kill to the spawned child", async () => {
    const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    let resolveExit: (code: number | null) => void = () => undefined;
    const killCalls: NodeJS.Signals[] = [];
    const child: ServeChildHandle = {
      kill: (signal) => { killCalls.push(signal); resolveExit(0); },
      pid: 1,
      waitForExit: () => new Promise((resolve) => { resolveExit = resolve; })
    };
    const runPromise = runServe([], {
      ...fakeRepoFs(),
      env: () => ({}),
      fetchImpl: connectionRefused as unknown as typeof globalThis.fetch,
      registerSignalHandler: (event, handler) => { handlers.set(event, handler); },
      spawn: () => child
    });
    // Drain the microtask queue (probeServeHealth's rejected-fetch resolution)
    // so the child is spawned + handlers registered before SIGINT fires —
    // setImmediate runs after ALL pending microtasks, unlike a fixed number
    // of `await Promise.resolve()` ticks, which would be timing-fragile.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    handlers.get("SIGINT")?.();
    const { exitCode } = await runPromise;
    expect(killCalls).toEqual(["SIGTERM"]);
    expect(exitCode).toBeUndefined();
  });
});

describe("muse serve --install / --uninstall / --status (AC2)", () => {
  it("--install refuses on a non-darwin platform", async () => {
    const { stderr, exitCode } = await runServe(["--install"], { ...fakeRepoFs(), platform: "linux" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("only wired for macOS");
  });

  it("--install on darwin unloads stale, writes+loads, and confirms via `list`", async () => {
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => {
      calls.push(args);
      if (args[0] === "unload") return { code: 1, stderr: "not found", stdout: "" };
      if (args[0] === "load") return { code: 0, stderr: "", stdout: "" };
      return { code: 0, stderr: "", stdout: '{\n\t"PID" = 42;\n};\n' };
    };
    const { stdout, exitCode } = await runServe(["--install"], { ...fakeRepoFs(), platform: "darwin", runLaunchctl });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("pid 42");
    expect(calls[0]?.[0]).toBe("unload");
    expect(calls[1]?.[0]).toBe("load");
  });

  it("--uninstall on a machine with no plist is a clean no-op", async () => {
    const { stdout, exitCode } = await runServe(["--uninstall"], {
      env: () => ({ MUSE_API_PLIST_FILE: "/tmp/does-not-exist-muse-api.plist" }),
      existsSync: () => false,
      platform: "darwin"
    });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("was not installed");
  });

  it("--status reports not-running on a free port", async () => {
    const { stdout, exitCode } = await runServe(["--status"], {
      env: () => ({}),
      existsSync: () => false,
      fetchImpl: connectionRefused as unknown as typeof globalThis.fetch,
      platform: "darwin"
    });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("not running");
    expect(stdout).toContain("not installed");
  });

  it("--status reports running + version when healthy", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pid: 99, startedAtIso: "2026-07-14T00:00:00.000Z", version: "dev" }));
    const { stdout, exitCode } = await runServe(["--status"], {
      env: () => ({}),
      existsSync: () => false,
      fetchImpl,
      platform: "darwin"
    });
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("running at");
    expect(stdout).toContain("pid 99");
  });
});
