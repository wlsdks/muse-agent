import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
      return { code: 0, stderr: "", stdout: "2026-07-22T02:00:00.000Z\n" };
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
});
