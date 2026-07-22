import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectResidentDaemonRuntime,
  collectPersonalAgentQualificationObservations,
  inspectGitSnapshot,
  inspectOrphanApiProcesses,
  parseCapabilityEvidenceInspection,
  readStrictBacklogCounts,
  type ReadOnlyCommandRunner
} from "./personal-agent-qualification-probes.js";
import { buildLaunchAgentPlist } from "./commands-daemon-launchagent.js";
import {
  beginCapabilityEvidenceAttempt,
  finalizeCapabilityEvidenceAttempt,
  inspectCapabilityEvidence
} from "../../../scripts/eval-agent-evidence.mjs";
import {
  AGENT_CAPABILITY_MATRIX_ID,
  AGENT_CAPABILITY_REQUIREMENTS,
  qualifyPersonalAgent
} from "./personal-agent-qualification.js";

const QUALIFY_NOW = new Date("2026-07-21T12:00:00.000Z");
const QUALIFY_SOURCE = { revision: "a".repeat(40), tree: "clean" as const };
const QUALIFY_ARTIFACTS = { count: 12, digest: "b".repeat(64), status: "ok" as const };

function capabilityReport() {
  return {
    capabilities: AGENT_CAPABILITY_REQUIREMENTS.map((requirement) => ({
      durationMs: 1,
      executed: requirement.repeats,
      id: requirement.id,
      requested: requirement.repeats,
      required: requirement.required,
      status: "passed"
    })),
    counts: { failed: 0, passed: 11, total: 11, unverified: 0 },
    generatedAt: "2026-07-21T11:30:00.000Z",
    matrixId: AGENT_CAPABILITY_MATRIX_ID,
    provenance: {
      artifactsAfterBuild: QUALIFY_ARTIFACTS,
      artifactsAtEnd: QUALIFY_ARTIFACTS,
      sourceAfterBuild: QUALIFY_SOURCE,
      sourceAtEnd: QUALIFY_SOURCE,
      sourceBeforeBuild: QUALIFY_SOURCE
    },
    status: "passed",
    version: 2
  };
}

function exactFixtureManifest(root: string): readonly string[] {
  const rows: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        rows.push(`${name}|dir|${(stat.mode & 0o777).toString(8)}|${stat.size.toString()}|${stat.mtimeMs.toString()}`);
        visit(path);
      } else {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        rows.push(`${name}|file|${(stat.mode & 0o777).toString(8)}|${stat.size.toString()}|${stat.mtimeMs.toString()}|${digest}`);
      }
    }
  };
  visit(root);
  return rows.sort();
}

function qualificationFixture(options: {
  readonly overdueFollowup?: boolean;
  readonly report?: "present" | "missing";
  readonly liveArgumentMismatch?: boolean;
  readonly omitLiveHome?: boolean;
  readonly liveProvider?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-qualify-fixture-"));
  const cliEntry = join(root, "stable-muse-entry.js");
  const plistFile = join(root, "com.muse.daemon.plist");
  const reportFile = join(root, "latest.json");
  const sidecarFile = join(root, "state", "proactive-sidecar.json");
  const heartbeatFile = join(root, "state", "proactive-heartbeat-daemon-loop.json");
  const followupsFile = join(root, "followups.json");
  const remindersFile = join(root, "reminders.json");
  const daemonConfigFile = join(root, "daemon.json");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(cliEntry, "export {};\n");
  writeFileSync(heartbeatFile, JSON.stringify({ at: "2026-07-21T11:59:00.000Z", pid: 4321 }));
  writeFileSync(followupsFile, JSON.stringify({ followups: options.overdueFollowup
    ? [{ scheduledFor: "2026-07-20T00:00:00.000Z", status: "scheduled" }]
    : [] }));
  writeFileSync(remindersFile, JSON.stringify({ reminders: [] }));
  writeFileSync(daemonConfigFile, JSON.stringify({ provider: "log" }));
  if (options.report !== "missing") {
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath: reportFile });
    finalizeCapabilityEvidenceAttempt(attempt, capabilityReport());
  }

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    MUSE_DAEMON_CONFIG_FILE: daemonConfigFile,
    MUSE_DAEMON_DELIVERY_ENABLED: "true",
    MUSE_DAEMON_PLIST_FILE: plistFile,
    MUSE_DAEMON_PROVIDER_LOCK: "log",
    MUSE_FOLLOWUPS_FILE: followupsFile,
    MUSE_LOCAL_ONLY: "true",
    MUSE_PROACTIVE_PROVIDER: "log",
    MUSE_PROACTIVE_SIDECAR_FILE: sidecarFile,
    MUSE_REMINDERS_FILE: remindersFile,
    MUSE_SELFLEARN_ENABLED: "false"
  };
  const diskArgs = [process.execPath, cliEntry, "daemon"];
  writeFileSync(plistFile, buildLaunchAgentPlist({
    environmentVariables: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
    label: "com.muse.daemon",
    programArguments: diskArgs,
    stderrPath: join(root, "stderr.log"),
    stdoutPath: join(root, "stdout.log")
  }));
  const liveArgs = options.liveArgumentMismatch
    ? [...diskArgs, `--provider=${options.liveProvider ?? "log"}`]
    : diskArgs;
  const launchctlPrint = [
    "gui/501/com.muse.daemon = {",
    "  arguments = {",
    ...liveArgs.map((arg) => `    ${arg}`),
    "  }",
    "  environment = {",
    ...Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && (!options.omitLiveHome || entry[0] !== "HOME"))
      .map(([key, value]) => `    ${key} => ${value}`),
    "  }",
    "  pid = 4321",
    "}"
  ].join("\n");
  const run: ReadOnlyCommandRunner = async (executable, args) => {
    if (executable === "git") {
      return args.includes("rev-parse")
        ? { code: 0, stderr: "", stdout: `${QUALIFY_SOURCE.revision}\n` }
        : { code: 0, stderr: "", stdout: "" };
    }
    if (executable === "launchctl") {
      return args[0] === "list"
        ? { code: 0, stderr: "", stdout: '"PID" = 4321;\n"LastExitStatus" = 0;\n' }
        : { code: 0, stderr: "", stdout: launchctlPrint };
    }
    if (executable === "ps" && args[0] === "-p") {
      return { code: 0, stderr: "", stdout: "2026-07-21T11:00:00.000Z\n" };
    }
    if (executable === "ps") return { code: 0, stderr: "", stdout: "" };
    return { code: 1, stderr: "PRIVATE raw failure", stdout: "" };
  };
  return {
    dependencies: {
      artifactDigest: async () => QUALIFY_ARTIFACTS,
      capabilityEvidence: async (file: string, allowedRoot: string) => inspectCapabilityEvidence({
        allowedRoot,
        reportPath: file
      }),
      daemonTemporaryRoots: [],
      env,
      now: () => QUALIFY_NOW,
      platform: "darwin" as const,
      run,
      uid: 501
    },
    options: { capabilityReportFile: reportFile, workspaceDir: root },
    root
  };
}

describe("strict read-only backlog probe", () => {
  it("counts metadata without serializing personal fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-qualify-backlog-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({ followups: [
      { status: "scheduled", scheduledFor: "2026-07-20T00:00:00Z", summary: "PRIVATE", userId: "PRIVATE" },
      { status: "scheduled", scheduledFor: "2026-07-23T00:00:00Z", summary: "PRIVATE", userId: "PRIVATE" },
      { status: "fired", scheduledFor: "2026-07-19T00:00:00Z", summary: "PRIVATE", userId: "PRIVATE" }
    ] }));
    await expect(readStrictBacklogCounts(file, "followups", Date.parse("2026-07-21T00:00:00Z"))).resolves.toEqual({
      overdue: 1,
      scheduled: 2,
      status: "ok"
    });
  });

  it("never quarantines malformed owner state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-qualify-malformed-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, "{private malformed");
    const before = readdirSync(dir);
    await expect(readStrictBacklogCounts(file, "reminders", Date.now())).resolves.toEqual({
      overdue: 0,
      scheduled: 0,
      status: "unverified"
    });
    expect(readdirSync(dir)).toEqual(before);
  });
});

describe("resident daemon runtime collector", () => {
  it("shares exactly the qualification runtime observation without reading capability evidence", async () => {
    const fixture = qualificationFixture();
    const qualification = await collectPersonalAgentQualificationObservations(fixture.options, fixture.dependencies);
    const resident = await collectResidentDaemonRuntime(fixture.dependencies);

    expect(resident).toEqual(qualification.runtime);
  });
});

describe("orphan API process probe", () => {
  it("counts only PPID-1 tsx API roots and their descendants, never returning raw details", async () => {
    const run: ReadOnlyCommandRunner = async (executable, args) => {
      if (executable === "ps") {
        return {
          code: 0,
          stderr: "",
          stdout: [
            "83172 1 node /repo/node_modules/tsx/dist/cli.mjs src/index.ts",
            "83178 83172 node --import tsx src/index.ts",
            "90000 1 node /other/node_modules/tsx/dist/cli.mjs src/index.ts",
            "90001 7 node /repo/node_modules/tsx/dist/cli.mjs src/index.ts"
          ].join("\n")
        };
      }
      const pid = args[2];
      return pid === "83172"
        ? { code: 0, stderr: "", stdout: "p83172\nn/Users/example/Muse/apps/api\n" }
        : { code: 0, stderr: "", stdout: `p${pid ?? ""}\nn/Users/example/other\n` };
    };
    const result = await inspectOrphanApiProcesses("darwin", run);
    expect(result).toEqual({ orphanProbe: "ok", orphanProcessCount: 2, orphanRootCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/83172|Muse|src\/index|cwd|command/iu);
  });

  it("fails closed when cwd identity cannot be read", async () => {
    const run: ReadOnlyCommandRunner = async (executable) => executable === "ps"
      ? { code: 0, stderr: "", stdout: "88 1 node /x/tsx src/index.ts\n" }
      : { code: 1, stderr: "PRIVATE /path pid=88", stdout: "" };
    await expect(inspectOrphanApiProcesses("darwin", run)).resolves.toEqual({
      orphanProbe: "unverified",
      orphanProcessCount: 0,
      orphanRootCount: 0
    });
  });
});

describe("git source probe", () => {
  it("disables optional locks and returns only revision/tree", async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const run: ReadOnlyCommandRunner = async (_executable, args, options) => {
      calls.push({ args, env: options?.env });
      return args.includes("rev-parse")
        ? { code: 0, stderr: "", stdout: `${"a".repeat(40)}\n` }
        : { code: 0, stderr: "", stdout: "" };
    };
    await expect(inspectGitSnapshot("/workspace", run)).resolves.toEqual({ revision: "a".repeat(40), tree: "clean" });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args[0]).toBe("--no-optional-locks");
      expect(call.env?.GIT_OPTIONAL_LOCKS).toBe("0");
    }
    expect(calls.some((call) => call.args.includes("--untracked-files=all"))).toBe(true);
  });
});

describe("qualification collector integration", () => {
  it("rejects completed inspector output without its four-file fingerprint", () => {
    expect(parseCapabilityEvidenceInspection({
      artifact: { state: "parsed", value: capabilityReport() },
      state: "completed",
      status: "passed"
    })).toEqual({ artifact: { state: "invalid" }, state: "invalid" });
  });

  it("can prove a complete sparse local fixture without raw identity fields", async () => {
    const fixture = qualificationFixture();
    const before = exactFixtureManifest(fixture.root);
    const observations = await collectPersonalAgentQualificationObservations(fixture.options, fixture.dependencies);
    const report = qualifyPersonalAgent(observations);
    expect(report.status, JSON.stringify(report)).toBe("qualified");
    expect(report.gates.map((gate) => gate.status)).toEqual(["passed", "passed", "passed"]);
    expect(JSON.stringify(report)).not.toMatch(/stable-muse-entry|PRIVATE|4321|muse-qualify-fixture/iu);
    expect(exactFixtureManifest(fixture.root)).toEqual(before);
  });

  it("keeps the host home only as a heartbeat-path fallback when launchctl omits it", async () => {
    const fixture = qualificationFixture({ omitLiveHome: true });
    const report = qualifyPersonalAgent(
      await collectPersonalAgentQualificationObservations(fixture.options, fixture.dependencies)
    );

    expect(report.status, JSON.stringify(report)).toBe("qualified");
    expect(report.gates[1].evidence.heartbeatState).toBe("fresh");
    expect(report.gates[1].evidence.processIdentityMatch).toBe(true);
  });

  it("re-reads evidence after source/artifact probes and rejects a concurrent new attempt", async () => {
    const fixture = qualificationFixture();
    let reads = 0;
    const observations = await collectPersonalAgentQualificationObservations(fixture.options, {
      ...fixture.dependencies,
      capabilityEvidence: async () => {
        reads += 1;
        return reads === 1
          ? {
              artifact: { state: "parsed" as const, value: capabilityReport() },
              fingerprint: "a".repeat(64),
              state: "completed" as const,
              status: "passed" as const
            }
          : {
              artifact: { state: "parsed" as const, value: capabilityReport() },
              fingerprint: "b".repeat(64),
              state: "running" as const
            };
      }
    });

    expect(reads).toBe(2);
    expect(observations.capability.attempt.stable).toBe(false);
    expect(qualifyPersonalAgent(observations).gates[0]).toMatchObject({
      reasonCodes: ["capability-attempt-changed-during-qualification"],
      status: "unverified"
    });
  });

  it("fails a real overdue delivery backlog and refuses to synthesize disk/live identity", async () => {
    const overdue = qualificationFixture({ overdueFollowup: true });
    const overdueReport = qualifyPersonalAgent(
      await collectPersonalAgentQualificationObservations(overdue.options, overdue.dependencies)
    );
    expect(overdueReport.status).toBe("not-qualified");
    expect(overdueReport.gates[2].reasonCodes).toContain("overdue-followups-detected");

    const mismatched = qualificationFixture({ liveArgumentMismatch: true, liveProvider: "telegram" });
    const mismatchReport = qualifyPersonalAgent(
      await collectPersonalAgentQualificationObservations(mismatched.options, mismatched.dependencies)
    );
    expect(mismatchReport.status).toBe("not-qualified");
    expect(mismatchReport.gates[1].reasonCodes).toContain("daemon-live-definition-mismatch");
    expect(mismatchReport.gates[2].status).toBe("failed");
    expect(mismatchReport.gates[2].reasonCodes).toContain("delivery-route-not-local-log");
    expect(mismatchReport.gates[2].reasonCodes).toContain("delivery-environment-unverified");
    expect(mismatchReport.gates[2].evidence.baseProviderLocalLog).toBe(false);
  });

  it("keeps missing capability evidence unverified instead of borrowing a documented baseline", async () => {
    const fixture = qualificationFixture({ report: "missing" });
    const report = qualifyPersonalAgent(
      await collectPersonalAgentQualificationObservations(fixture.options, fixture.dependencies)
    );
    expect(report.status, JSON.stringify(report)).toBe("unverified");
    expect(report.gates[0].reasonCodes).toContain("capability-attempt-state-missing");
  });

  it("rejects a default capability-report parent symlink without following it", async () => {
    if (process.platform === "win32") return;
    const fixture = qualificationFixture({ report: "missing" });
    const outside = mkdtempSync(join(tmpdir(), "muse-qualify-report-outside-"));
    const outsideReport = join(outside, "evals", "agent-capability", "latest.json");
    mkdirSync(join(outside, "evals", "agent-capability"), { recursive: true });
    writeFileSync(outsideReport, JSON.stringify(capabilityReport()), { mode: 0o600 });
    chmodSync(outsideReport, 0o600);
    symlinkSync(outside, join(fixture.root, ".muse-dev"), "dir");
    const before = createHash("sha256").update(readFileSync(outsideReport)).digest("hex");

    const report = qualifyPersonalAgent(await collectPersonalAgentQualificationObservations(
      { workspaceDir: fixture.root },
      fixture.dependencies
    ));

    expect(report.status).toBe("unverified");
    expect(report.gates[0].reasonCodes).toContain("capability-attempt-state-invalid");
    expect(createHash("sha256").update(readFileSync(outsideReport)).digest("hex")).toBe(before);
  });
});
