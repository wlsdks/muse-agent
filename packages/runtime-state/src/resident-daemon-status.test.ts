import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendResidentDaemonFailure,
  beginResidentDaemonTerminalGeneration,
  markResidentDaemonStable
} from "./resident-daemon-terminal-state.js";
import {
  inspectResidentDaemon,
  parseResidentDaemonHeartbeatReceipt,
  parseResidentWriterLeaseIdentity,
  validateStableMuseCliEntry,
  validateStableMuseRuntimeExecutable,
  type ReadOnlyProcessRunner
} from "./resident-daemon-status.js";

const NOW = new Date("2026-07-22T03:00:00.000Z");
const RESIDENT_GENERATION = "resident_generation_01";

function residentHeartbeat(at: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    at,
    expectedCadenceMs: 60_000,
    generation: RESIDENT_GENERATION,
    lastProgressAt: at,
    pid: 4321,
    sequence: 7,
    version: 1,
    ...overrides
  };
}

function writeResidentLease(root: string, overrides: Readonly<Record<string, unknown>> = {}): string {
  const leaseRoot = join(root, ".muse", "resident-writer-lease");
  const file = join(leaseRoot, "active.json");
  mkdirSync(leaseRoot, { mode: 0o700, recursive: true });
  writeFileSync(file, JSON.stringify({
    createdAtMs: Date.parse("2026-07-22T02:00:01.000Z"),
    pid: 4321,
    role: "background",
    sequence: 1,
    token: RESIDENT_GENERATION,
    version: 1,
    ...overrides
  }), { mode: 0o600 });
  return file;
}

function writeResidentTerminal(root: string): string {
  const museRoot = join(root, ".muse");
  const file = join(museRoot, "resident-daemon-terminal-state.json");
  mkdirSync(museRoot, { mode: 0o700, recursive: true });
  const started = beginResidentDaemonTerminalGeneration({
    generation: RESIDENT_GENERATION,
    now: new Date("2026-07-22T02:00:01.000Z"),
    pid: 4321
  });
  const stable = markResidentDaemonStable(
    started,
    "tick-completed",
    new Date("2026-07-22T02:59:00.000Z")
  );
  writeFileSync(file, JSON.stringify(stable), { mode: 0o600 });
  return file;
}

describe("resident daemon heartbeat receipt", () => {
  const valid = {
    at: "2026-07-22T03:00:00.000Z",
    expectedCadenceMs: 60_000,
    generation: RESIDENT_GENERATION,
    lastProgressAt: "2026-07-22T02:59:59.000Z",
    pid: 4321,
    sequence: 7,
    version: 1
  };

  it("accepts only the exact canonical versioned receipt", () => {
    expect(parseResidentDaemonHeartbeatReceipt(JSON.stringify(valid))).toEqual(valid);
  });

  it.each([
    ["partial JSON", "{\"version\":1"],
    ["legacy mark", JSON.stringify({ at: valid.at, pid: valid.pid })],
    ["unknown key", JSON.stringify({ ...valid, private: "hidden" })],
    ["future version", JSON.stringify({ ...valid, version: 2 })],
    ["weak generation", JSON.stringify({ ...valid, generation: "short" })],
    ["zero sequence", JSON.stringify({ ...valid, sequence: 0 })],
    ["fractional sequence", JSON.stringify({ ...valid, sequence: 1.5 })],
    ["too-fast cadence", JSON.stringify({ ...valid, expectedCadenceMs: 4_999 })],
    ["too-slow cadence", JSON.stringify({ ...valid, expectedCadenceMs: 86_400_001 })],
    ["noncanonical timestamp", JSON.stringify({ ...valid, at: "2026-07-22T03:00:00Z" })],
    ["progress after write", JSON.stringify({ ...valid, lastProgressAt: "2026-07-22T03:00:01.000Z" })]
  ])("rejects %s", (_name, text) => {
    expect(parseResidentDaemonHeartbeatReceipt(text)).toBeUndefined();
  });

  it("accepts only the exact background writer lease identity", () => {
    const validLease = {
      createdAtMs: Date.parse("2026-07-22T02:00:01.000Z"),
      pid: 4321,
      role: "background",
      sequence: 1,
      token: RESIDENT_GENERATION,
      version: 1
    };
    expect(parseResidentWriterLeaseIdentity(JSON.stringify(validLease))).toEqual(validLease);
    expect(parseResidentWriterLeaseIdentity(JSON.stringify({
      ...validLease,
      role: "foreground"
    }))).toBeUndefined();
    expect(parseResidentWriterLeaseIdentity(JSON.stringify({
      ...validLease,
      private: "hidden"
    }))).toBeUndefined();
  });
});

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plist(arguments_: readonly string[], environment: Readonly<Record<string, string>>): string {
  return `<plist><dict><key>ProgramArguments</key><array>${arguments_.map((value) => `<string>${escapeXml(value)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join("")}</dict></dict></plist>`;
}

function stableCliPackage(root: string): string {
  const packageRoot = join(root, "apps", "cli");
  const entry = join(packageRoot, "dist", "cli.mjs");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    bin: { muse: "./dist/cli.mjs" },
    name: "@muse/cli"
  }));
  writeFileSync(entry, "export {};\n");
  return entry;
}

function fixture(options: { readonly liveDelivery?: string; readonly heartbeatAt?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-resident-status-"));
  const plistFile = join(root, "daemon.plist");
  const sidecar = join(root, "proactive-sidecar.json");
  const heartbeat = join(root, "proactive-heartbeat-daemon-loop.json");
  const entry = stableCliPackage(root);
  const environment = {
    HOME: root,
    MUSE_DAEMON_DELIVERY_ENABLED: "false",
    MUSE_PROACTIVE_SIDECAR_FILE: sidecar
  };
  const arguments_ = [process.execPath, entry, "daemon"];
  writeFileSync(plistFile, plist(arguments_, environment));
  writeFileSync(
    heartbeat,
    JSON.stringify(residentHeartbeat(options.heartbeatAt ?? "2026-07-22T02:59:00.000Z")),
    { mode: 0o600 }
  );
  const lease = writeResidentLease(root);
  const terminal = writeResidentTerminal(root);
  const liveEnvironment = { ...environment, MUSE_DAEMON_DELIVERY_ENABLED: options.liveDelivery ?? "false" };
  const print = [
    "gui/501/com.muse.daemon = {",
    "arguments = {",
    ...arguments_.map((value) => `  ${value}`),
    "}",
    "environment = {",
    ...Object.entries(liveEnvironment).map(([key, value]) => `  ${key} => ${value}`),
    "}",
    "pid = 4321",
    "}"
  ].join("\n");
  const run: ReadOnlyProcessRunner = async (executable, args) => {
    if (executable === "launchctl") {
      return args[0] === "list"
        ? { code: 0, stderr: "", stdout: '"PID" = 4321;\n"LastExitStatus" = 0;\n' }
        : { code: 0, stderr: "", stdout: print };
    }
    if (executable === "ps" && args[0] === "-p") {
      return { code: 0, stderr: "", stdout: "Wed Jul 22 02:00:00 2026\n" };
    }
    if (executable === "ps") return { code: 0, stderr: "", stdout: "" };
    return { code: 1, stderr: "unexpected", stdout: "" };
  };
  return { environment, heartbeat, lease, plistFile, root, run, terminal };
}

function fingerprint(file: string): string {
  const stat = statSync(file);
  return `${stat.size.toString()}:${stat.mtimeMs.toString()}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

describe("stable Muse CLI entry authority", () => {
  it("accepts only the canonical current Node regular executable", () => {
    expect(validateStableMuseRuntimeExecutable(process.execPath)).toMatchObject({
      executable: realpathSync(process.execPath),
      ok: true
    });
    expect(validateStableMuseRuntimeExecutable("/bin/echo")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not match the current Node runtime")
    });
    expect(validateStableMuseRuntimeExecutable("/usr")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a regular file")
    });
  });

  it("accepts only the canonical declared muse bin of an @muse/cli package", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-stable-cli-"));
    const entry = stableCliPackage(root);
    expect(validateStableMuseCliEntry(entry, { temporaryRoots: [] })).toMatchObject({
      entrypoint: realpathSync(entry),
      ok: true,
      packageRoot: realpathSync(join(root, "apps", "cli"))
    });

    const source = join(root, "apps", "cli", "src", "index.test.ts");
    mkdirSync(join(root, "apps", "cli", "src"), { recursive: true });
    writeFileSync(source, "export {};\n");
    expect(validateStableMuseCliEntry(source, { temporaryRoots: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("declared muse bin")
    });

    const arbitrary = join(root, "arbitrary.mjs");
    writeFileSync(arbitrary, "export {};\n");
    expect(validateStableMuseCliEntry(arbitrary, { temporaryRoots: [] })).toMatchObject({ ok: false });
  });

  it("fails closed for temporary, moved-away, malformed, and escaping package entries", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-stable-cli-reject-"));
    const entry = stableCliPackage(root);
    expect(validateStableMuseCliEntry(entry, { temporaryRoots: [root] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("temporary directory")
    });

    unlinkSync(entry);
    expect(validateStableMuseCliEntry(entry, { temporaryRoots: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not exist")
    });

    const malformedRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-malformed-"));
    const malformedEntry = join(malformedRoot, "dist", "index.js");
    mkdirSync(join(malformedRoot, "dist"), { recursive: true });
    writeFileSync(malformedEntry, "export {};\n");
    writeFileSync(join(malformedRoot, "package.json"), "{broken");
    expect(validateStableMuseCliEntry(malformedEntry, { temporaryRoots: [] })).toMatchObject({ ok: false });

    const directoryBinRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-directory-bin-"));
    const directoryBin = join(directoryBinRoot, "dist");
    mkdirSync(directoryBin, { recursive: true });
    writeFileSync(join(directoryBinRoot, "package.json"), JSON.stringify({
      bin: { muse: "./dist" },
      name: "@muse/cli"
    }));
    expect(validateStableMuseCliEntry(directoryBin, { temporaryRoots: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a regular file")
    });

    const unnamedBinRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-unnamed-bin-"));
    const unnamedBin = join(unnamedBinRoot, "dist", "index.js");
    mkdirSync(join(unnamedBinRoot, "dist"), { recursive: true });
    writeFileSync(unnamedBin, "export {};\n");
    writeFileSync(join(unnamedBinRoot, "package.json"), JSON.stringify({
      bin: "./dist/index.js",
      name: "@muse/cli"
    }));
    expect(validateStableMuseCliEntry(unnamedBin, { temporaryRoots: [] })).toMatchObject({ ok: false });

    const declaredTestRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-declared-test-"));
    const declaredTestBin = join(declaredTestRoot, "src", "entry.test.ts");
    mkdirSync(join(declaredTestRoot, "src"), { recursive: true });
    writeFileSync(declaredTestBin, "export {};\n");
    writeFileSync(join(declaredTestRoot, "package.json"), JSON.stringify({
      bin: { muse: "./src/entry.test.ts" },
      name: "@muse/cli"
    }));
    expect(validateStableMuseCliEntry(declaredTestBin, { temporaryRoots: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("test output")
    });

    const declaredSpecRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-declared-spec-"));
    const declaredSpecBin = join(declaredSpecRoot, "spec", "index.js");
    mkdirSync(join(declaredSpecRoot, "spec"), { recursive: true });
    writeFileSync(declaredSpecBin, "export {};\n");
    writeFileSync(join(declaredSpecRoot, "package.json"), JSON.stringify({
      bin: { muse: "./spec/index.js" },
      name: "@muse/cli"
    }));
    expect(validateStableMuseCliEntry(declaredSpecBin, { temporaryRoots: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("test output")
    });

    if (process.platform !== "win32") {
      const symlinkRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-symlink-"));
      const symlinkTarget = join(symlinkRoot, "dist", "index.js");
      const symlinkBin = join(symlinkRoot, "dist", "muse.js");
      mkdirSync(join(symlinkRoot, "dist"), { recursive: true });
      writeFileSync(symlinkTarget, "export {};\n");
      symlinkSync(symlinkTarget, symlinkBin);
      writeFileSync(join(symlinkRoot, "package.json"), JSON.stringify({
        bin: { muse: "./dist/muse.js" },
        name: "@muse/cli"
      }));
      expect(validateStableMuseCliEntry(symlinkBin, { temporaryRoots: [] })).toMatchObject({ ok: false });

      const aliasedPackageRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-package-alias-"));
      const realPackage = join(aliasedPackageRoot, "real-cli");
      const packageAlias = join(aliasedPackageRoot, "alias-cli");
      const realEntry = join(realPackage, "dist", "index.js");
      const entryAlias = join(realPackage, "dist", "alias.js");
      mkdirSync(join(realPackage, "dist"), { recursive: true });
      writeFileSync(realEntry, "export {};\n");
      writeFileSync(join(realPackage, "package.json"), JSON.stringify({
        bin: { muse: "./dist/index.js" },
        name: "@muse/cli"
      }));
      symlinkSync(realPackage, packageAlias);
      symlinkSync(realEntry, entryAlias);
      expect(validateStableMuseCliEntry(join(packageAlias, "dist", "index.js"), { temporaryRoots: [] })).toMatchObject({
        ok: false
      });
      expect(validateStableMuseCliEntry(entryAlias, { temporaryRoots: [] })).toMatchObject({ ok: false });
    }

    const declaredRunnerRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-declared-runner-"));
    const declaredRunnerBin = join(declaredRunnerRoot, "dist", "runner.js");
    mkdirSync(join(declaredRunnerRoot, "dist"), { recursive: true });
    writeFileSync(declaredRunnerBin, "export {};\n");
    writeFileSync(join(declaredRunnerRoot, "package.json"), JSON.stringify({
      bin: { muse: "./dist/runner.js" },
      name: "@muse/cli"
    }));
    expect(validateStableMuseCliEntry(declaredRunnerBin, { temporaryRoots: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("test output")
    });

    const escapingRoot = mkdtempSync(join(tmpdir(), "muse-stable-cli-escape-"));
    const outsideEntry = join(escapingRoot, "outside.js");
    const packageRoot = join(escapingRoot, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(outsideEntry, "export {};\n");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      bin: { muse: "../outside.js" },
      name: "@muse/cli"
    }));
    expect(validateStableMuseCliEntry(outsideEntry, { temporaryRoots: [] })).toMatchObject({ ok: false });
  });
});

function inventoryFixture(options: {
  readonly artifact?: "valid" | "missing";
  readonly launchdRunning?: boolean;
  readonly residentPids?: readonly number[];
  readonly orphanTree?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-resident-inventory-"));
  const apiCwd = join(root, "apps", "api");
  const cliEntry = stableCliPackage(root);
  const plistFile = join(root, "daemon.plist");
  const sidecar = join(root, "proactive-sidecar.json");
  const heartbeat = join(root, "proactive-heartbeat-daemon-loop.json");
  mkdirSync(apiCwd, { recursive: true });
  const environment = { HOME: root, MUSE_PROACTIVE_SIDECAR_FILE: sidecar };
  const arguments_ = [process.execPath, cliEntry, "daemon"];
  writeFileSync(plistFile, plist(arguments_, environment));
  if (options.artifact === "missing") unlinkSync(plistFile);
  writeFileSync(
    heartbeat,
    JSON.stringify(residentHeartbeat("2026-07-22T02:59:00.000Z")),
    { mode: 0o600 }
  );
  writeResidentLease(root);
  writeResidentTerminal(root);
  const launchdRunning = options.launchdRunning ?? true;
  const residentPids = options.residentPids ?? (launchdRunning ? [4321] : []);
  const rows = [
    ...residentPids.map((pid) => `${pid.toString()} 1 ${process.execPath} ${cliEntry} daemon`),
    ...(options.orphanTree
      ? [
          `5000 1 ${process.execPath} ${root}/node_modules/.bin/tsx src/index.ts`,
          `5001 5000 ${process.execPath} worker.mjs`
        ]
      : [])
  ];
  const print = [
    "gui/501/com.muse.daemon = {",
    "arguments = {",
    ...arguments_.map((value) => `  ${value}`),
    "}",
    "environment = {",
    ...Object.entries(environment).map(([key, value]) => `  ${key} => ${value}`),
    "}",
    "pid = 4321",
    "}"
  ].join("\n");
  const run: ReadOnlyProcessRunner = async (executable, args) => {
    if (executable === "launchctl" && args[0] === "list") {
      return launchdRunning
        ? { code: 0, stderr: "", stdout: '"PID" = 4321;\n"LastExitStatus" = 0;\n' }
        : { code: 1, stderr: "Could not find service", stdout: "" };
    }
    if (executable === "launchctl") return { code: 0, stderr: "", stdout: print };
    if (executable === "ps" && args[0] === "-axo") {
      return { code: 0, stderr: "", stdout: rows.length > 0 ? `${rows.join("\n")}\n` : "" };
    }
    if (executable === "ps" && args[0] === "-p") {
      return { code: 0, stderr: "", stdout: "Wed Jul 22 02:00:00 2026\n" };
    }
    if (executable === "lsof") {
      const pid = Number(args[args.indexOf("-p") + 1]);
      const descriptor = args[args.indexOf("-d") + 1];
      const path = descriptor === "txt" ? process.execPath : pid >= 5000 ? apiCwd : root;
      return { code: 0, stderr: "", stdout: `p${pid.toString()}\nf${descriptor}\nn${path}\n` };
    }
    return { code: 1, stderr: "unexpected", stdout: "" };
  };
  return { cliEntry, plistFile, root, run };
}

describe("resident daemon read-only authority", () => {
  it("requires matching disk/live definitions, PID, process age, and a fresh heartbeat", async () => {
    const state = fixture();
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.observation).toMatchObject({
      artifact: "valid",
      heartbeat: "fresh",
      liveDefinitionMatches: true,
      liveProbe: "ok",
      pidAgreement: true,
      runtime: "running",
      stableMuseCommand: true
    });
    expect(result.effectiveRuntimeEnv.MUSE_DAEMON_DELIVERY_ENABLED).toBe("false");
  });

  it("projects a redacted terminal failure through the shared health result", async () => {
    const state = fixture();
    const started = beginResidentDaemonTerminalGeneration({
      generation: RESIDENT_GENERATION,
      now: new Date("2026-07-22T02:00:01.000Z"),
      pid: 4321
    });
    const stable = markResidentDaemonStable(
      started,
      "heartbeat-established",
      new Date("2026-07-22T02:00:02.000Z")
    );
    const failed = appendResidentDaemonFailure(stable, {
      cause: Object.assign(new Error("secret provider token"), { code: "EAUTH" }),
      context: { domain: "provider" },
      id: "diagnostic_00000001",
      now: new Date("2026-07-22T02:00:03.000Z")
    });
    writeFileSync(state.terminal, JSON.stringify(failed), { mode: 0o600 });

    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.health).toMatchObject({
      reasonCodes: expect.arrayContaining(["daemon-terminal-provider-auth-failed"]),
      status: "failed",
      terminalFailure: {
        at: "2026-07-22T02:00:03.000Z",
        diagnosticRef: "muse://resident-diagnostics/diagnostic_00000001",
        exitClass: "authentication",
        lastStablePoint: "heartbeat-established",
        reasonCode: "provider-auth-failed"
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret provider token");
  });

  it("fails closed for missing, malformed, and wrong-generation terminal receipts", async () => {
    const missing = fixture();
    unlinkSync(missing.terminal);
    const missingResult = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: missing.root, MUSE_DAEMON_PLIST_FILE: missing.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: missing.run,
      uid: 501
    });
    expect(missingResult.health.reasonCodes).toContain("daemon-terminal-state-missing");

    const malformed = fixture();
    writeFileSync(malformed.terminal, "{\"version\":1", { mode: 0o600 });
    const malformedResult = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: malformed.root, MUSE_DAEMON_PLIST_FILE: malformed.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: malformed.run,
      uid: 501
    });
    expect(malformedResult.health.reasonCodes).toContain("daemon-terminal-state-invalid");

    const mismatched = fixture();
    const wrongGeneration = markResidentDaemonStable(
      beginResidentDaemonTerminalGeneration({
        generation: "different_generation_02",
        now: new Date("2026-07-22T02:00:01.000Z"),
        pid: 4321
      }),
      "tick-completed",
      new Date("2026-07-22T02:59:00.000Z")
    );
    writeFileSync(mismatched.terminal, JSON.stringify(wrongGeneration), { mode: 0o600 });
    const mismatchedResult = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: mismatched.root, MUSE_DAEMON_PLIST_FILE: mismatched.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: mismatched.run,
      uid: 501
    });
    expect(mismatchedResult.health.reasonCodes).toContain("daemon-terminal-generation-mismatch");
  });

  it.each([
    {
      expected: "invalid",
      name: "partial write",
      write: (state: ReturnType<typeof fixture>) => writeFileSync(state.heartbeat, "{\"version\":1", { mode: 0o600 })
    },
    {
      expected: "invalid",
      name: "legacy mark",
      write: (state: ReturnType<typeof fixture>) => writeFileSync(
        state.heartbeat,
        JSON.stringify({ at: "2026-07-22T02:59:00.000Z", pid: 4321 }),
        { mode: 0o600 }
      )
    },
    {
      expected: "generation-mismatch",
      name: "stale generation",
      write: (state: ReturnType<typeof fixture>) => writeFileSync(
        state.heartbeat,
        JSON.stringify(residentHeartbeat("2026-07-22T02:59:00.000Z", {
          generation: "resident_generation_00"
        })),
        { mode: 0o600 }
      )
    },
    {
      expected: "progress-stale",
      name: "recent liveness without progress",
      write: (state: ReturnType<typeof fixture>) => writeFileSync(
        state.heartbeat,
        JSON.stringify(residentHeartbeat("2026-07-22T02:59:30.000Z", {
          lastProgressAt: "2026-07-22T02:50:00.000Z"
        })),
        { mode: 0o600 }
      )
    },
    {
      expected: "invalid",
      name: "corrupt lease authority",
      write: (state: ReturnType<typeof fixture>) => writeFileSync(
        state.lease,
        JSON.stringify({ private: "do-not-leak" }),
        { mode: 0o600 }
      )
    }
  ])("fails closed for $name evidence", async ({ expected, write }) => {
    const state = fixture();
    write(state);
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.observation.heartbeat).toBe(expected);
    expect(result.health.status).toBe("failed");
  });

  it("rejects non-owner-only heartbeat permissions", async () => {
    if (process.platform === "win32") return;
    const state = fixture();
    chmodSync(state.heartbeat, 0o644);
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.observation.heartbeat).toBe("invalid");
    expect(result.health).toMatchObject({
      reasonCodes: expect.arrayContaining(["daemon-heartbeat-invalid"]),
      status: "failed"
    });
  });

  it("rejects a same-PID receipt that predates the live process incarnation", async () => {
    const state = fixture();
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      if (executable === "ps" && args[0] === "-p") {
        return { code: 0, stderr: "", stdout: "Wed Jul 22 11:59:30 2026\n" };
      }
      return state.run(executable, args, options);
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.observation.heartbeat).toBe("before-process");
    expect(result.health.status).not.toBe("healthy");
  });

  it("keeps the live environment authoritative and exposes definition drift", async () => {
    const state = fixture({ liveDelivery: "true" });
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.observation.liveDefinitionMatches).toBe(false);
    expect(result.effectiveRuntimeEnv.MUSE_DAEMON_DELIVERY_ENABLED).toBe("true");
  });

  it("rejects a matching disk/live definition that uses an arbitrary executable", async () => {
    const state = fixture();
    writeFileSync(state.plistFile, readFileSync(state.plistFile, "utf8").replaceAll(process.execPath, "/bin/echo"));
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      const result = await state.run(executable, args, options);
      return executable === "launchctl" && args[0] === "print"
        ? { ...result, stdout: result.stdout.replaceAll(process.execPath, "/bin/echo") }
        : result;
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.observation.artifact).toBe("stale");
    expect(result.observation.stableMuseCommand).toBe(false);
  });

  it("does not alter daemon evidence while inspecting it", async () => {
    const state = fixture({ heartbeatAt: "2026-07-22T02:50:00.000Z" });
    const before = {
      entries: readdirSync(state.root).sort(),
      heartbeat: fingerprint(state.heartbeat),
      plist: fingerprint(state.plistFile)
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.observation.heartbeat).toBe("stale");
    expect({
      entries: readdirSync(state.root).sort(),
      heartbeat: fingerprint(state.heartbeat),
      plist: fingerprint(state.plistFile)
    }).toEqual(before);
  });

  it("can keep API inspection to launchctl and one PID start-time probe", async () => {
    const state = fixture();
    const commands: string[] = [];
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      commands.push(`${executable} ${args.join(" ")}`);
      return state.run(executable, args, options);
    };
    await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      inspectOrphans: false,
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(commands).toEqual([
      "launchctl list com.muse.daemon",
      "launchctl print gui/501/com.muse.daemon",
      "ps -p 4321 -o lstart="
    ]);
  });

  it.each([
    {
      expected: { conditions: ["artifact-only"], duplicateResidentProcessCount: 0, museProcessCount: 0, residentProcessCount: 0 },
      expectedHealth: {
        reasonCodes: [
          "daemon-not-registered",
          "resident-process-missing",
          "daemon-live-probe-unverified",
          "daemon-heartbeat-invalid"
        ],
        status: "failed"
      },
      name: "artifact-only",
      options: { launchdRunning: false, residentPids: [] }
    },
    {
      expected: { conditions: ["process-only"], duplicateResidentProcessCount: 0, museProcessCount: 1, residentProcessCount: 1 },
      expectedHealth: { reasonCodes: expect.arrayContaining(["daemon-artifact-missing", "daemon-not-registered"]), status: "failed" },
      name: "process-only",
      options: { artifact: "missing" as const, launchdRunning: false, residentPids: [4330] }
    },
    {
      expected: { conditions: ["duplicate"], duplicateResidentProcessCount: 1, museProcessCount: 2, residentProcessCount: 2 },
      expectedHealth: { reasonCodes: expect.arrayContaining(["duplicate-resident-processes-detected"]), status: "failed" },
      name: "duplicate",
      options: { residentPids: [4321, 4322] }
    },
    {
      expected: { conditions: ["orphan"], duplicateResidentProcessCount: 0, museProcessCount: 3, residentProcessCount: 1 },
      expectedHealth: { reasonCodes: ["orphan-api-processes-detected"], status: "failed" },
      name: "orphan",
      options: { orphanTree: true }
    },
    {
      expected: { conditions: ["healthy"], duplicateResidentProcessCount: 0, museProcessCount: 1, residentProcessCount: 1 },
      expectedHealth: { reasonCodes: [], status: "healthy" },
      name: "healthy",
      options: {}
    }
  ])("distinguishes the $name inventory fixture", async ({ expected, expectedHealth, options }) => {
    const state = inventoryFixture(options);
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.processInventory).toMatchObject(expected);
    expect(result.health).toEqual(expectedHealth);
    expect(result.processInventory.processes).toHaveLength(expected.museProcessCount);
    for (const process_ of result.processInventory.processes) {
      expect(process_).toMatchObject({
        cwd: expect.any(String),
        executableRealpath: expect.any(String),
        matchesLaunchdPid: expect.any(Boolean),
        pid: expect.any(Number),
        ppid: expect.any(Number),
        role: expect.stringMatching(/^(?:resident|orphan-api|orphan-api-descendant)$/u),
        startedAt: new Date("Wed Jul 22 02:00:00 2026").toISOString()
      });
    }
    const privacySafe = JSON.stringify(result.observation);
    expect(privacySafe).not.toContain(state.root);
    expect(privacySafe).not.toMatch(/4321|4322|4330|5000|5001/u);
  });

  it("fails the bounded inventory closed when a process identity path cannot be proven", async () => {
    const state = inventoryFixture();
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      if (executable === "lsof" && args.includes("txt")) return { code: 1, stderr: "denied", stdout: "" };
      return state.run(executable, args, options);
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.processInventory).toEqual({
      conditions: ["unverified"],
      duplicateResidentProcessCount: 0,
      museProcessCount: 0,
      probe: "unverified",
      processes: [],
      residentProcessCount: 0
    });
  });

  it("fails closed instead of probing an unbounded resident candidate set", async () => {
    const state = inventoryFixture({ residentPids: Array.from({ length: 33 }, (_, index) => 6000 + index) });
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.processInventory).toMatchObject({
      conditions: ["unverified"],
      duplicateResidentProcessCount: 0,
      museProcessCount: 0,
      probe: "unverified",
      residentProcessCount: 0
    });
  });

  it("caps orphan-shaped candidates before issuing any per-process lsof probe", async () => {
    const state = inventoryFixture();
    let lsofCalls = 0;
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      if (executable === "ps" && args[0] === "-axo") {
        return {
          code: 0,
          stderr: "",
          stdout: `${Array.from({ length: 33 }, (_, index) =>
            `${(7000 + index).toString()} 1 ${process.execPath} /repo/node_modules/.bin/tsx src/index.ts`).join("\n")}\n`
        };
      }
      if (executable === "lsof") lsofCalls += 1;
      return state.run(executable, args, options);
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.processInventory.conditions).toEqual(["unverified"]);
    expect(result.observation.orphanProbe).toBe("unverified");
    expect(lsofCalls).toBe(0);
  });

  it("caps the combined resident and orphan candidate set before any lsof probe", async () => {
    const state = inventoryFixture();
    let lsofCalls = 0;
    const residentRows = Array.from({ length: 20 }, (_, index) =>
      `${(8000 + index).toString()} 1 ${process.execPath} ${state.cliEntry} daemon`);
    const orphanRows = Array.from({ length: 20 }, (_, index) =>
      `${(9000 + index).toString()} 1 ${process.execPath} /repo/node_modules/.bin/tsx src/index.ts`);
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      if (executable === "ps" && args[0] === "-axo") {
        return { code: 0, stderr: "", stdout: `${[...residentRows, ...orphanRows].join("\n")}\n` };
      }
      if (executable === "lsof") lsofCalls += 1;
      return state.run(executable, args, options);
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.processInventory.conditions).toEqual(["unverified"]);
    expect(result.observation.orphanProbe).toBe("unverified");
    expect(lsofCalls).toBe(0);
  });

  it.each(["0", "1", "2026", "Thu Feb 31 02:00:00 2026", "Wed Jul 22 25:00:00 2026"])(
    "rejects malformed or normalized process start evidence %j",
    async (start) => {
      const state = inventoryFixture();
      const run: ReadOnlyProcessRunner = async (executable, args, options) => {
        if (executable === "ps" && args[0] === "-p") return { code: 0, stderr: "", stdout: `${start}\n` };
        return state.run(executable, args, options);
      };
      const result = await inspectResidentDaemon({
        daemonTemporaryRoots: [],
        env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
        now: () => NOW,
        platform: "darwin",
        run,
        uid: 501
      });

      expect(result.processInventory.conditions).toEqual(["unverified"]);
      expect(result.processInventory.processes).toEqual([]);
    }
  );

  it("rejects duplicate PID rows as ambiguous process-table evidence", async () => {
    const state = inventoryFixture();
    const row = `4321 1 ${process.execPath} ${state.cliEntry} daemon`;
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      if (executable === "ps" && args[0] === "-axo") {
        return { code: 0, stderr: "", stdout: `${row}\n${row}\n` };
      }
      return state.run(executable, args, options);
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.processInventory.conditions).toEqual(["unverified"]);
    expect(result.observation.orphanProbe).toBe("unverified");
  });

  it("does not match an unrelated node command that merely contains the daemon entrypoint", async () => {
    const state = inventoryFixture();
    const run: ReadOnlyProcessRunner = async (executable, args, options) => {
      if (executable === "ps" && args[0] === "-axo") {
        return { code: 0, stderr: "", stdout: `4321 1 ${process.execPath} /tmp/other.mjs ${state.cliEntry} daemon\n` };
      }
      return state.run(executable, args, options);
    };
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run,
      uid: 501
    });

    expect(result.processInventory).toMatchObject({
      conditions: ["artifact-only"],
      museProcessCount: 0,
      residentProcessCount: 0
    });
  });

  it("does not classify a lone resident candidate as healthy unless it matches the live launchd PID", async () => {
    const state = inventoryFixture({ residentPids: [4322] });
    const result = await inspectResidentDaemon({
      daemonTemporaryRoots: [],
      env: { HOME: state.root, MUSE_DAEMON_PLIST_FILE: state.plistFile },
      now: () => NOW,
      platform: "darwin",
      run: state.run,
      uid: 501
    });

    expect(result.processInventory).toMatchObject({
      conditions: ["degraded"],
      museProcessCount: 1,
      residentProcessCount: 1
    });
    expect(result.processInventory.processes[0]?.matchesLaunchdPid).toBe(false);
  });
});
