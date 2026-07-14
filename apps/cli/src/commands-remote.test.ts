import { describe, expect, it } from "vitest";

import {
  authPosture,
  checkApiReachable,
  checkServeActive,
  checkTailscaleLogin,
  defaultRemoteRunner,
  extractLocalPort,
  installUrlForPlatform,
  parseServeStatusJson,
  parseTailscaleStatusJson,
  phoneUrl,
  resolveTailscaleBinary,
  runRemoteDisableCommand,
  runRemoteEnableCommand,
  runRemoteStatusCommand,
  type RemoteCommandDeps,
  type RemoteEnableDeps,
  type RemoteExecResult,
  type RemoteRunner
} from "./commands-remote.js";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

function makeRun(script: (call: Call) => RemoteExecResult): { readonly run: RemoteRunner; readonly calls: Call[] } {
  const calls: Call[] = [];
  const run: RemoteRunner = async (call) => {
    calls.push({ args: call.args, command: call.command });
    return script(call);
  };
  return { calls, run };
}

const ok = (stdout = ""): RemoteExecResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const fail = (stderr = "boom", exitCode = 1): RemoteExecResult => ({ exitCode, stderr, stdout: "", timedOut: false });

const RUNNING_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "amelie-workstation.pango-lin.ts.net." }
});
const NEEDS_LOGIN_STATUS_JSON = JSON.stringify({ BackendState: "NeedsLogin" });
const SERVE_ACTIVE_JSON = JSON.stringify({ Web: { "amelie-workstation.pango-lin.ts.net:443": {} } });
const SERVE_OFF_JSON = JSON.stringify({});

function fakeFetch(ok_: boolean): typeof globalThis.fetch {
  return (async () => ({ ok: ok_ }) as Response) as typeof globalThis.fetch;
}

describe("defaultRemoteRunner", () => {
  it("refuses to exec for real under vitest (hard boundary)", async () => {
    await expect(
      defaultRemoteRunner({ args: ["version"], command: "tailscale", cwd: "/tmp", timeoutMs: 1000 })
    ).rejects.toThrow(/refusing to exec real/u);
  });
});

describe("installUrlForPlatform", () => {
  it("returns the per-OS download page", () => {
    expect(installUrlForPlatform("darwin")).toBe("https://tailscale.com/download/mac");
    expect(installUrlForPlatform("linux")).toBe("https://tailscale.com/download/linux");
    expect(installUrlForPlatform("win32")).toBe("https://tailscale.com/download/windows");
  });

  it("falls back to the generic download page for an unknown platform", () => {
    expect(installUrlForPlatform("freebsd" as NodeJS.Platform)).toBe("https://tailscale.com/download");
  });
});

describe("resolveTailscaleBinary", () => {
  it("returns 'tailscale' when the PATH probe succeeds", async () => {
    const { run } = makeRun(() => ok("1.90.0\n"));
    const binary = await resolveTailscaleBinary({ cwd: "/tmp", run });
    expect(binary).toBe("tailscale");
  });

  it("falls back to the macOS app-bundle CLI when PATH lookup throws and the bundle exists", async () => {
    let call = 0;
    const run: RemoteRunner = async (c) => {
      call += 1;
      if (call === 1) throw new Error("spawn tailscale ENOENT");
      expect(c.command).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
      return ok("1.90.0\n");
    };
    const binary = await resolveTailscaleBinary({
      cwd: "/tmp",
      exists: (p) => p === "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      osPlatform: "darwin",
      run
    });
    expect(binary).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  });

  it("returns undefined when PATH lookup fails and there's no macOS bundle fallback", async () => {
    const run: RemoteRunner = async () => {
      throw new Error("spawn tailscale ENOENT");
    };
    const binary = await resolveTailscaleBinary({ cwd: "/tmp", exists: () => false, osPlatform: "linux", run });
    expect(binary).toBeUndefined();
  });
});

describe("parseTailscaleStatusJson / checkTailscaleLogin", () => {
  it("parses BackendState + trims the trailing dot off Self.DNSName", () => {
    const parsed = parseTailscaleStatusJson(RUNNING_STATUS_JSON);
    expect(parsed).toEqual({ backendState: "Running", dnsName: "amelie-workstation.pango-lin.ts.net" });
  });

  it("returns undefined on invalid JSON", () => {
    expect(parseTailscaleStatusJson("not json")).toBeUndefined();
  });

  it("checkTailscaleLogin reports loggedIn only for BackendState 'Running'", async () => {
    const { run } = makeRun(() => ok(RUNNING_STATUS_JSON));
    const status = await checkTailscaleLogin({ binary: "tailscale", cwd: "/tmp", run });
    expect(status).toEqual({ backendState: "Running", dnsName: "amelie-workstation.pango-lin.ts.net", loggedIn: true });
  });

  it("checkTailscaleLogin reports NOT logged in for NeedsLogin", async () => {
    const { run } = makeRun(() => ok(NEEDS_LOGIN_STATUS_JSON));
    const status = await checkTailscaleLogin({ binary: "tailscale", cwd: "/tmp", run });
    expect(status.loggedIn).toBe(false);
    expect(status.backendState).toBe("NeedsLogin");
  });

  it("checkTailscaleLogin treats a failed exec as not logged in", async () => {
    const run: RemoteRunner = async () => {
      throw new Error("boom");
    };
    const status = await checkTailscaleLogin({ binary: "tailscale", cwd: "/tmp", run });
    expect(status.loggedIn).toBe(false);
  });
});

describe("parseServeStatusJson / checkServeActive", () => {
  it("true when Web has entries", () => {
    expect(parseServeStatusJson(SERVE_ACTIVE_JSON)).toBe(true);
  });

  it("false for an empty config", () => {
    expect(parseServeStatusJson(SERVE_OFF_JSON)).toBe(false);
  });

  it("false on invalid JSON", () => {
    expect(parseServeStatusJson("nope")).toBe(false);
  });

  it("checkServeActive returns false when the exec fails", async () => {
    const { run } = makeRun(() => fail());
    expect(await checkServeActive({ binary: "tailscale", cwd: "/tmp", run })).toBe(false);
  });
});

describe("extractLocalPort", () => {
  it("reads an explicit port", () => {
    expect(extractLocalPort("http://127.0.0.1:3030")).toBe(3030);
  });

  it("defaults to 443/80 by scheme when no port is present", () => {
    expect(extractLocalPort("https://example.com")).toBe(443);
    expect(extractLocalPort("http://example.com")).toBe(80);
  });

  it("falls back to 3030 for a malformed URL", () => {
    expect(extractLocalPort("not a url")).toBe(3030);
  });
});

describe("checkApiReachable", () => {
  it("true when fetch resolves ok", async () => {
    expect(await checkApiReachable("http://127.0.0.1:3030", fakeFetch(true))).toBe(true);
  });

  it("false when fetch resolves not-ok", async () => {
    expect(await checkApiReachable("http://127.0.0.1:3030", fakeFetch(false))).toBe(false);
  });

  it("false when fetch throws", async () => {
    const throwing: typeof globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    expect(await checkApiReachable("http://127.0.0.1:3030", throwing)).toBe(false);
  });
});

describe("authPosture", () => {
  it("on when MUSE_AUTH_JWT_SECRET is set", () => {
    expect(authPosture({ MUSE_AUTH_JWT_SECRET: "secret" })).toBe("on");
  });

  it("on when MUSE_AUTH_SECRETS_FILE is set", () => {
    expect(authPosture({ MUSE_AUTH_SECRETS_FILE: "/path/to/secrets.json" })).toBe("on");
  });

  it("off when neither is set", () => {
    expect(authPosture({})).toBe("off");
  });

  it("off for whitespace-only values", () => {
    expect(authPosture({ MUSE_AUTH_JWT_SECRET: "   " })).toBe("off");
  });
});

describe("phoneUrl", () => {
  it("prefixes https://", () => {
    expect(phoneUrl("amelie-workstation.pango-lin.ts.net")).toBe("https://amelie-workstation.pango-lin.ts.net");
  });
});

function baseStatusDeps(run: RemoteRunner, overrides: Partial<RemoteCommandDeps> = {}): RemoteCommandDeps {
  return {
    baseUrl: "http://127.0.0.1:3030",
    env: {},
    fetchImpl: fakeFetch(true),
    osPlatform: "darwin",
    run,
    stderr: () => undefined,
    stdout: () => undefined,
    ...overrides
  };
}

describe("runRemoteStatusCommand", () => {
  it("prints the phone URL when tailscale is installed, logged in, and serving", async () => {
    const { run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_ACTIVE_JSON);
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteStatusCommand(baseStatusDeps(run, { stdout: (m) => messages.push(m) }));
    expect(exitCode).toBe(0);
    const out = messages.join("");
    expect(out).toMatch(/tailscale: found/u);
    expect(out).toMatch(/logged in: yes/u);
    expect(out).toMatch(/serve: active/u);
    expect(out).toMatch(/phone URL: https:\/\/amelie-workstation\.pango-lin\.ts\.net/u);
    expect(out).toMatch(/API server: reachable/u);
  });

  it("prints the auth-off warning exactly when auth is off, and not when it's on", async () => {
    const { run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_OFF_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const offMessages: string[] = [];
    await runRemoteStatusCommand(baseStatusDeps(run, { env: {}, stdout: (m) => offMessages.push(m) }));
    expect(offMessages.join("")).toMatch(/auth: OFF/u);

    const { run: run2 } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_OFF_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const onMessages: string[] = [];
    await runRemoteStatusCommand(
      baseStatusDeps(run2, { env: { MUSE_AUTH_JWT_SECRET: "secret" }, stdout: (m) => onMessages.push(m) })
    );
    expect(onMessages.join("")).toMatch(/auth: ON/u);
    expect(onMessages.join("")).not.toMatch(/auth: OFF/u);
  });

  it("reports not-installed without crashing when tailscale is missing", async () => {
    const run: RemoteRunner = async () => {
      throw new Error("spawn tailscale ENOENT");
    };
    const messages: string[] = [];
    const exitCode = await runRemoteStatusCommand(
      baseStatusDeps(run, { exists: () => false, stdout: (m) => messages.push(m) })
    );
    expect(exitCode).toBe(0);
    expect(messages.join("")).toMatch(/tailscale: not installed/u);
  });
});

function baseEnableDeps(run: RemoteRunner, overrides: Partial<RemoteEnableDeps> = {}): RemoteEnableDeps {
  return {
    baseUrl: "http://127.0.0.1:3030",
    env: {},
    fetchImpl: fakeFetch(true),
    funnel: false,
    osPlatform: "darwin",
    run,
    stderr: () => undefined,
    stdout: () => undefined,
    ...overrides
  };
}

describe("runRemoteEnableCommand — safety invariants", () => {
  it("--funnel refuses BEFORE any exec — zero calls", async () => {
    const { calls, run } = makeRun(() => ok());
    const messages: string[] = [];
    const exitCode = await runRemoteEnableCommand(baseEnableDeps(run, { funnel: true, stderr: (m) => messages.push(m) }));
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(messages.join("")).toMatch(/refusing --funnel/u);
    expect(calls.some((c) => c.args.some((a) => a.includes("funnel")))).toBe(false);
  });

  it("no tailscale binary → nothing beyond the detect probe; install guidance printed", async () => {
    const { calls, run } = makeRun(() => {
      throw new Error("spawn tailscale ENOENT");
    });
    const messages: string[] = [];
    const exitCode = await runRemoteEnableCommand(
      baseEnableDeps(run, { exists: () => false, stderr: (m) => messages.push(m) })
    );
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["version"]);
    expect(messages.join("")).toMatch(/isn't installed/u);
    expect(messages.join("")).toMatch(/tailscale\.com\/download\/mac/u);
  });

  it("not logged in → no serve executed", async () => {
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(NEEDS_LOGIN_STATUS_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteEnableCommand(baseEnableDeps(run, { stderr: (m) => messages.push(m) }));
    expect(exitCode).toBe(1);
    expect(calls.some((c) => c.args[0] === "serve")).toBe(false);
    expect(messages.join("")).toMatch(/not logged in/u);
    expect(messages.join("")).toMatch(/tailscale up/u);
  });

  it("API server down → no serve executed", async () => {
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteEnableCommand(
      baseEnableDeps(run, { fetchImpl: fakeFetch(false), stderr: (m) => messages.push(m) })
    );
    expect(exitCode).toBe(1);
    expect(calls.some((c) => c.args[0] === "serve")).toBe(false);
    expect(messages.join("")).toMatch(/isn't reachable/u);
  });

});

describe("runRemoteEnableCommand — success + idempotency", () => {
  it("runs `tailscale serve --bg <port>` and prints the phone URL", async () => {
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_OFF_JSON);
      if (key === "serve --bg 3030") return ok("Available within your tailnet...\n");
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteEnableCommand(baseEnableDeps(run, { stdout: (m) => messages.push(m) }));
    expect(exitCode).toBe(0);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "version",
      "status --json",
      "serve status --json",
      "serve --bg 3030"
    ]);
    const out = messages.join("");
    expect(out).toMatch(/https:\/\/amelie-workstation\.pango-lin\.ts\.net/u);
    expect(out).toMatch(/open this on your phone/u);
  });

  it("is idempotent — already serving skips the serve exec, still prints the URL", async () => {
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_ACTIVE_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteEnableCommand(baseEnableDeps(run, { stdout: (m) => messages.push(m) }));
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.args[0] === "serve" && c.args[1] === "--bg")).toBe(false);
    expect(messages.join("")).toMatch(/https:\/\/amelie-workstation\.pango-lin\.ts\.net/u);
  });

  it("prints the auth-off warning only when auth is off", async () => {
    const { run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_ACTIVE_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    await runRemoteEnableCommand(baseEnableDeps(run, { env: {}, stdout: (m) => messages.push(m) }));
    expect(messages.join("")).toMatch(/auth is OFF/u);

    const { run: run2 } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "status --json") return ok(RUNNING_STATUS_JSON);
      if (key === "serve status --json") return ok(SERVE_ACTIVE_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const onMessages: string[] = [];
    await runRemoteEnableCommand(
      baseEnableDeps(run2, { env: { MUSE_AUTH_JWT_SECRET: "secret" }, stdout: (m) => onMessages.push(m) })
    );
    expect(onMessages.join("")).not.toMatch(/auth is OFF/u);
  });
});

function baseDisableDeps(run: RemoteRunner, overrides: Partial<RemoteCommandDeps> = {}): RemoteCommandDeps {
  return {
    baseUrl: "http://127.0.0.1:3030",
    env: {},
    fetchImpl: fakeFetch(true),
    osPlatform: "darwin",
    run,
    stderr: () => undefined,
    stdout: () => undefined,
    ...overrides
  };
}

describe("runRemoteDisableCommand", () => {
  it("resets serve when currently active", async () => {
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "serve status --json") return ok(SERVE_ACTIVE_JSON);
      if (key === "serve reset") return ok("");
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteDisableCommand(baseDisableDeps(run, { stdout: (m) => messages.push(m) }));
    expect(exitCode).toBe(0);
    expect(calls.map((c) => c.args.join(" "))).toEqual(["version", "serve status --json", "serve reset"]);
    expect(messages.join("")).toMatch(/no longer being served/u);
  });

  it("is idempotent — not serving is a friendly no-op, no reset executed", async () => {
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "version") return ok("1.90.0\n");
      if (key === "serve status --json") return ok(SERVE_OFF_JSON);
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runRemoteDisableCommand(baseDisableDeps(run, { stdout: (m) => messages.push(m) }));
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.args[0] === "reset" || c.args.includes("reset"))).toBe(false);
    expect(messages.join("")).toMatch(/already off/u);
  });

  it("not installed → friendly no-op, zero calls beyond the detect probe", async () => {
    const { calls, run } = makeRun(() => {
      throw new Error("spawn tailscale ENOENT");
    });
    const messages: string[] = [];
    const exitCode = await runRemoteDisableCommand(
      baseDisableDeps(run, { exists: () => false, stdout: (m) => messages.push(m) })
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(messages.join("")).toMatch(/isn't installed/u);
  });
});
