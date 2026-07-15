import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  decideServeAction,
  defaultServeFetch,
  defaultServeSpawn,
  hostForProbe,
  probeServeHealth,
  probeWebUi,
  resolveServeHost,
  resolveServePort,
  resolveServeWebDir,
  runServeForeground,
  shutdownAndWaitFree,
  type ServeChildHandle
} from "./commands-serve-core.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function htmlResponse(status = 404): Response {
  return new Response("<html><body>not found</body></html>", { headers: { "content-type": "text/html" }, status });
}

describe("resolveServePort / resolveServeHost", () => {
  it("parses a valid PORT string", () => {
    expect(resolveServePort("4321")).toBe(4321);
  });

  it("falls back to 3030 on missing, empty, non-numeric, or out-of-range input", () => {
    expect(resolveServePort(undefined)).toBe(3030);
    expect(resolveServePort("")).toBe(3030);
    expect(resolveServePort("3030x")).toBe(3030);
    expect(resolveServePort("0")).toBe(3030);
    expect(resolveServePort("70000")).toBe(3030);
  });

  it("resolveServeHost trims and falls back to 127.0.0.1 on empty/unset", () => {
    expect(resolveServeHost(" 0.0.0.0 ")).toBe("0.0.0.0");
    expect(resolveServeHost(undefined)).toBe("127.0.0.1");
    expect(resolveServeHost("  ")).toBe("127.0.0.1");
  });
});

describe("hostForProbe", () => {
  it("maps a wildcard bind host to loopback for the client-side probe", () => {
    expect(hostForProbe("0.0.0.0")).toBe("127.0.0.1");
    expect(hostForProbe("::")).toBe("127.0.0.1");
    expect(hostForProbe("192.168.1.5")).toBe("192.168.1.5");
  });
});

describe("resolveServeWebDir (muse serve default web UI)", () => {
  it("auto-detects apps/web/dist when MUSE_WEB_DIR is unset and index.html exists", () => {
    const exists = (path: string) => path === join("/repo", "apps", "web", "dist", "index.html");
    const result = resolveServeWebDir({}, "/repo", exists);
    expect(result).toEqual({ builtInMissing: false, webDir: join("/repo", "apps", "web", "dist") });
  });

  it("reports builtInMissing (no webDir) when MUSE_WEB_DIR is unset and the dist build isn't there", () => {
    const result = resolveServeWebDir({}, "/repo", () => false);
    expect(result).toEqual({ builtInMissing: true });
  });

  it("an explicit MUSE_WEB_DIR always wins, even when apps/web/dist also exists", () => {
    const exists = () => true;
    const result = resolveServeWebDir({ MUSE_WEB_DIR: "/custom/web-dir" }, "/repo", exists);
    expect(result).toEqual({ builtInMissing: false, webDir: "/custom/web-dir" });
  });

  it("treats a whitespace-only MUSE_WEB_DIR as unset and falls through to auto-detect", () => {
    const exists = (path: string) => path === join("/repo", "apps", "web", "dist", "index.html");
    const result = resolveServeWebDir({ MUSE_WEB_DIR: "   " }, "/repo", exists);
    expect(result).toEqual({ builtInMissing: false, webDir: join("/repo", "apps", "web", "dist") });
  });
});

describe("probeWebUi (muse serve --status web UI line, AC3)", () => {
  it("classifies HTTP 200 as serving", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html></html>", { status: 200 }));
    expect(await probeWebUi(fetchImpl, "http://127.0.0.1:3030")).toBe("serving");
  });

  it("classifies HTTP 404 as not-serving", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    expect(await probeWebUi(fetchImpl, "http://127.0.0.1:3030")).toBe("not-serving");
  });

  it("classifies any other status or a network failure as honestly unknown, never guessed", async () => {
    const errorFetch = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await probeWebUi(errorFetch, "http://127.0.0.1:3030")).toBe("unknown");
    const oddStatusFetch = vi.fn().mockResolvedValue(new Response("teapot", { status: 418 }));
    expect(await probeWebUi(oddStatusFetch, "http://127.0.0.1:3030")).toBe("unknown");
  });
});

describe("probeServeHealth", () => {
  it("classifies a connection-refused fetch as free", async () => {
    const err = new Error("fetch failed") as Error & { cause?: unknown };
    err.cause = { code: "ECONNREFUSED" };
    const fetchImpl = vi.fn().mockRejectedValue(err);
    const result = await probeServeHealth(fetchImpl, "http://127.0.0.1:3030/health");
    expect(result.kind).toBe("free");
  });

  it("classifies a valid /health JSON payload as healthy", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pid: 123, startedAtIso: "2026-07-14T00:00:00.000Z", version: "dev" }));
    const result = await probeServeHealth(fetchImpl, "http://127.0.0.1:3030/health");
    expect(result).toEqual({ kind: "healthy", pid: 123, startedAtIso: "2026-07-14T00:00:00.000Z", version: "dev" });
  });

  it("classifies a JSON body missing the /health shape as ambiguous", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const result = await probeServeHealth(fetchImpl, "http://127.0.0.1:3030/health");
    expect(result.kind).toBe("ambiguous");
  });

  it("classifies an HTML response as non-muse", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse());
    const result = await probeServeHealth(fetchImpl, "http://127.0.0.1:3030/health");
    expect(result.kind).toBe("non-muse");
  });

  it("classifies a non-refused fetch exception (e.g. a timeout) as ambiguous, never free", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
    const result = await probeServeHealth(fetchImpl, "http://127.0.0.1:3030/health");
    expect(result.kind).toBe("ambiguous");
  });
});

describe("decideServeAction — the safety-critical pure decision (AC4)", () => {
  it("spawns on a free port", () => {
    expect(decideServeAction({ kind: "free" }, "dev", false)).toEqual({ action: "spawn" });
  });

  it("never spawns a second server when a SAME-build server is already healthy", () => {
    const decision = decideServeAction({ kind: "healthy", pid: 1, startedAtIso: "t", version: "abc123" }, "abc123", false);
    expect(decision.action).toBe("already-running");
  });

  it("dev-vs-dev is treated as SAME (honest limitation) and flagged in the decision", () => {
    const decision = decideServeAction({ kind: "healthy", pid: 1, startedAtIso: "t", version: "dev" }, "dev", false);
    expect(decision).toMatchObject({ action: "already-running", bothDev: true });
  });

  it("a DIFFERENT build without --replace offers replace, never replaces on its own", () => {
    const decision = decideServeAction({ kind: "healthy", pid: 1, startedAtIso: "t", version: "old-build" }, "new-build", false);
    expect(decision.action).toBe("offer-replace");
  });

  it("a DIFFERENT build WITH --replace resolves to replace", () => {
    const decision = decideServeAction({ kind: "healthy", pid: 1, startedAtIso: "t", version: "old-build" }, "new-build", true);
    expect(decision.action).toBe("replace");
  });

  it("ambiguous health without --replace offers replace, not a silent spawn or silent kill", () => {
    const decision = decideServeAction({ kind: "ambiguous", detail: "weird" }, "dev", false);
    expect(decision.action).toBe("offer-replace");
  });

  it("a non-Muse occupant NEVER offers replace, regardless of the --replace flag — zero shutdown attempts", () => {
    expect(decideServeAction({ kind: "non-muse", detail: "html" }, "dev", false).action).toBe("fail-non-muse");
    expect(decideServeAction({ kind: "non-muse", detail: "html" }, "dev", true).action).toBe("fail-non-muse");
  });
});

describe("shutdownAndWaitFree", () => {
  it("succeeds once the port reports free after the shutdown POST", async () => {
    let healthCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/admin/shutdown")) return jsonResponse({ shuttingDown: true, version: "dev" });
      healthCalls += 1;
      if (healthCalls < 2) return jsonResponse({ pid: 1, startedAtIso: "t", version: "dev" });
      const err = new Error("fetch failed") as Error & { cause?: unknown };
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    });
    const result = await shutdownAndWaitFree(fetchImpl, "http://127.0.0.1:3030", "http://127.0.0.1:3030/health", {
      pollMs: 1,
      sleep: async () => undefined,
      waitMs: 1000
    });
    expect(result.ok).toBe(true);
  });

  it("fails when the shutdown POST itself errors — never claims success", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await shutdownAndWaitFree(fetchImpl, "http://127.0.0.1:3030", "http://127.0.0.1:3030/health");
    expect(result.ok).toBe(false);
  });

  it("fails when the port never frees within the wait budget", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/api/admin/shutdown")) return jsonResponse({ shuttingDown: true, version: "dev" });
      return jsonResponse({ pid: 1, startedAtIso: "t", version: "dev" }); // still answering, forever
    });
    const result = await shutdownAndWaitFree(fetchImpl, "http://127.0.0.1:3030", "http://127.0.0.1:3030/health", {
      pollMs: 1,
      sleep: async () => undefined,
      waitMs: 5
    });
    expect(result.ok).toBe(false);
  });
});

describe("vitest guards (AC4: no real spawn/fetch under vitest even if a test forgets to inject)", () => {
  it("defaultServeSpawn refuses to spawn a real child under vitest", () => {
    expect(() => defaultServeSpawn({ args: [], command: "node", cwd: "/repo", env: {} })).toThrow(/refusing to spawn/u);
  });

  it("defaultServeFetch refuses a real network fetch under vitest", async () => {
    await expect(defaultServeFetch("http://127.0.0.1:3030/health")).rejects.toThrow(/refusing a real network fetch/u);
  });
});

describe("runServeForeground — SIGINT forwards an explicit kill to the child (AC4)", () => {
  it("registers SIGINT/SIGTERM and forwards SIGTERM to the child when fired; propagates the child's exit code", async () => {
    const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const killCalls: NodeJS.Signals[] = [];
    let resolveExit: (code: number | null) => void = () => undefined;
    const child: ServeChildHandle = {
      kill: (signal) => {
        killCalls.push(signal);
        resolveExit(0);
      },
      pid: 4242,
      waitForExit: () => new Promise((resolve) => { resolveExit = resolve; })
    };
    const stdoutLines: string[] = [];

    const runPromise = runServeForeground({
      args: ["dist/index.js"],
      command: "node",
      cwd: "/repo",
      env: {},
      registerSignalHandler: (event, handler) => { handlers.set(event, handler); },
      spawn: () => child,
      stdout: (line) => { stdoutLines.push(line); }
    });

    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(killCalls).toHaveLength(0);

    handlers.get("SIGINT")!();

    const exitCode = await runPromise;
    expect(killCalls).toEqual(["SIGTERM"]);
    expect(exitCode).toBe(0);
    expect(stdoutLines.join("")).toContain("(stopping)");
  });

  it("propagates a non-zero child exit code without any signal firing", async () => {
    const child: ServeChildHandle = {
      kill: () => undefined,
      pid: 1,
      waitForExit: async () => 7
    };
    const exitCode = await runServeForeground({
      args: [],
      command: "node",
      cwd: "/repo",
      env: {},
      registerSignalHandler: () => undefined,
      spawn: () => child,
      stdout: () => undefined
    });
    expect(exitCode).toBe(7);
  });
});

describe("decideServeAction — dev-vs-dev --replace escape hatch (evaluator round-1 FAIL)", () => {
  it("an explicit --replace beats the dev==dev same-version short-circuit", async () => {
    const { decideServeAction } = await import("./commands-serve-core.js");
    const decision = decideServeAction(
      { kind: "healthy", pid: 1, startedAtIso: "2026-01-01T00:00:00Z", version: "dev" },
      "dev",
      true
    );
    expect(decision.action).toBe("replace");
  });

  it("without --replace, dev==dev still reports already-running with the bothDev note", async () => {
    const { decideServeAction } = await import("./commands-serve-core.js");
    const decision = decideServeAction(
      { kind: "healthy", pid: 1, startedAtIso: "2026-01-01T00:00:00Z", version: "dev" },
      "dev",
      false
    );
    expect(decision.action).toBe("already-running");
    expect((decision as { bothDev?: boolean }).bothDev).toBe(true);
  });

  it("a REAL (non-dev) same-version match ignores --replace (no accidental restart of an identical build)", async () => {
    const { decideServeAction } = await import("./commands-serve-core.js");
    const decision = decideServeAction(
      { kind: "healthy", pid: 1, startedAtIso: "2026-01-01T00:00:00Z", version: "abc123-1" },
      "abc123-1",
      true
    );
    expect(decision.action).toBe("already-running");
  });
});
