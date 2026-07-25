import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectResidentDaemon, type ReadOnlyProcessRunner } from "./resident-daemon-status.js";

const NOW = new Date("2026-07-22T03:00:00.000Z");

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plist(arguments_: readonly string[], environment: Readonly<Record<string, string>>): string {
  return `<plist><dict><key>ProgramArguments</key><array>${arguments_.map((value) => `<string>${escapeXml(value)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join("")}</dict></dict></plist>`;
}

function fixture(options: { readonly liveDelivery?: string; readonly heartbeatAt?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-resident-status-"));
  const plistFile = join(root, "daemon.plist");
  const sidecar = join(root, "proactive-sidecar.json");
  const heartbeat = join(root, "proactive-heartbeat-daemon-loop.json");
  const entry = fileURLToPath(import.meta.url);
  const environment = {
    HOME: root,
    MUSE_DAEMON_DELIVERY_ENABLED: "false",
    MUSE_PROACTIVE_SIDECAR_FILE: sidecar
  };
  const arguments_ = [process.execPath, entry, "daemon"];
  writeFileSync(plistFile, plist(arguments_, environment));
  writeFileSync(heartbeat, JSON.stringify({ at: options.heartbeatAt ?? "2026-07-22T02:59:00.000Z", pid: 4321 }));
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
  return { environment, heartbeat, plistFile, root, run };
}

function fingerprint(file: string): string {
  const stat = statSync(file);
  return `${stat.size.toString()}:${stat.mtimeMs.toString()}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function inventoryFixture(options: {
  readonly artifact?: "valid" | "missing";
  readonly launchdRunning?: boolean;
  readonly residentPids?: readonly number[];
  readonly orphanTree?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-resident-inventory-"));
  const apiCwd = join(root, "apps", "api");
  const cliEntry = join(root, "apps", "cli", "dist", "cli.mjs");
  const plistFile = join(root, "daemon.plist");
  const sidecar = join(root, "proactive-sidecar.json");
  const heartbeat = join(root, "proactive-heartbeat-daemon-loop.json");
  mkdirSync(join(root, "apps", "cli", "dist"), { recursive: true });
  mkdirSync(apiCwd, { recursive: true });
  writeFileSync(cliEntry, "export {};\n");
  const environment = { HOME: root, MUSE_PROACTIVE_SIDECAR_FILE: sidecar };
  const arguments_ = [process.execPath, cliEntry, "daemon"];
  writeFileSync(plistFile, plist(arguments_, environment));
  if (options.artifact === "missing") unlinkSync(plistFile);
  writeFileSync(heartbeat, JSON.stringify({ at: "2026-07-22T02:59:00.000Z", pid: 4321 }));
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

  it("does not alter daemon evidence while inspecting it", async () => {
    const state = fixture({ heartbeatAt: "2026-07-22T02:00:00.000Z" });
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
      name: "artifact-only",
      options: { launchdRunning: false, residentPids: [] }
    },
    {
      expected: { conditions: ["process-only"], duplicateResidentProcessCount: 0, museProcessCount: 1, residentProcessCount: 1 },
      name: "process-only",
      options: { artifact: "missing" as const, launchdRunning: false, residentPids: [4330] }
    },
    {
      expected: { conditions: ["duplicate"], duplicateResidentProcessCount: 1, museProcessCount: 2, residentProcessCount: 2 },
      name: "duplicate",
      options: { residentPids: [4321, 4322] }
    },
    {
      expected: { conditions: ["orphan"], duplicateResidentProcessCount: 0, museProcessCount: 3, residentProcessCount: 1 },
      name: "orphan",
      options: { orphanTree: true }
    },
    {
      expected: { conditions: ["healthy"], duplicateResidentProcessCount: 0, museProcessCount: 1, residentProcessCount: 1 },
      name: "healthy",
      options: {}
    }
  ])("distinguishes the $name inventory fixture", async ({ expected, options }) => {
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
