import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerQualifyCommand } from "./commands-qualify.js";
import {
  AGENT_CAPABILITY_MATRIX_ID,
  AGENT_CAPABILITY_REQUIREMENTS,
  type PersonalAgentQualificationObservations
} from "./personal-agent-qualification.js";
import type { ProgramIO } from "./program.js";

const SOURCE = { revision: "a".repeat(40), tree: "clean" as const };
const ARTIFACTS = { count: 12, digest: "b".repeat(64), status: "ok" as const };
const NOW = new Date("2026-07-21T12:00:00.000Z");

function observations(runtime: PersonalAgentQualificationObservations["runtime"]["runtime"]): PersonalAgentQualificationObservations {
  return {
    capability: {
      attempt: { stable: true, state: "missing" },
      artifact: { state: "missing" },
      currentArtifacts: ARTIFACTS,
      currentSourceEnd: SOURCE,
      currentSourceStart: SOURCE,
      maxAgeMs: 86_400_000
    },
    delivery: {
      baseProviderLocalLog: true,
      brakeEngaged: false,
      environmentProbe: "ok",
      followups: { overdue: 0, scheduled: 0, status: "ok" },
      localOnly: true,
      providerLockLog: true,
      reminders: { overdue: 0, scheduled: 0, status: "ok" },
      selfLearnDisabled: true
    },
    now: NOW,
    runtime: {
      artifact: runtime === "running" ? "valid" : "stale",
      autostartProbe: "ok",
      heartbeat: runtime === "running" ? "fresh" : "missing",
      liveDefinitionMatches: runtime === "running",
      liveProbe: runtime === "running" ? "ok" : "unverified",
      orphanProbe: "ok",
      orphanProcessCount: 0,
      orphanRootCount: 0,
      pidAgreement: runtime === "running",
      platform: "darwin",
      runtime,
      stableMuseCommand: runtime === "running"
    }
  };
}

function qualifiedObservations(): PersonalAgentQualificationObservations {
  const base = observations("running");
  return {
    ...base,
    capability: {
      ...base.capability,
      attempt: { stable: true, state: "completed", status: "passed" },
      artifact: {
        state: "parsed",
        value: {
          capabilities: AGENT_CAPABILITY_REQUIREMENTS.map((requirement) => ({
            durationMs: 1,
            executed: requirement.repeats,
            id: requirement.id,
            requested: requirement.repeats,
            required: requirement.required,
            status: "passed"
          })),
          counts: { failed: 0, passed: 11, total: 11, unverified: 0 },
          generatedAt: "2026-07-21T11:00:00.000Z",
          matrixId: AGENT_CAPABILITY_MATRIX_ID,
          provenance: {
            artifactsAfterBuild: ARTIFACTS,
            artifactsAtEnd: ARTIFACTS,
            sourceAfterBuild: SOURCE,
            sourceAtEnd: SOURCE,
            sourceBeforeBuild: SOURCE
          },
          status: "passed",
          version: 2
        }
      }
    }
  };
}

async function run(
  args: readonly string[],
  result: PersonalAgentQualificationObservations
): Promise<{ readonly exitCode: number | undefined; readonly stderr: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const io: ProgramIO = {
    stderr: (message) => stderr.push(message),
    stdout: (message) => stdout.push(message),
    workspaceDir: "/safe/workspace"
  };
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: io.stderr, writeOut: io.stdout });
  registerQualifyCommand(program, io, { collect: async () => result });
  try {
    await program.parseAsync(["node", "muse", "qualify", ...args], { from: "node" });
  } catch {
    // Commander throws under exitOverride for invalid CLI input.
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("muse qualify", () => {
  it("emits only the machine report in JSON mode and exits non-zero for unverified evidence", async () => {
    const result = await run(["--json"], observations("running"));
    const report = JSON.parse(result.stdout) as { status: string; readOnly: boolean };
    expect(report).toMatchObject({ readOnly: true, status: "unverified" });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
  });

  it("renders closed reason codes without private probe values", async () => {
    const result = await run([], observations("not-registered"));
    expect(result.stdout).toContain("Muse personal-agent qualification: NOT QUALIFIED");
    expect(result.stdout).toContain("daemon-not-registered");
    expect(result.stdout).not.toMatch(/safe\/workspace|PRIVATE|\bpid\b|src\/index\.ts/iu);
    expect(result.exitCode).toBe(1);
  });

  it("is exit zero only when every technical gate passes", async () => {
    const result = await run(["--json"], qualifiedObservations());
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "qualified" });
    expect(result.exitCode).toBe(0);
  });

  it("rejects an evidence age that could weaken the 24-hour ceiling", async () => {
    const result = await run(["--max-evidence-age-hours", "25"], observations("running"));
    expect(result.stderr).toContain("at most 24");
    expect(result.stdout).toBe("");
  });

  it("documents the three read-only options", async () => {
    const result = await run(["--help"], observations("running"));
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--capability-report <path>");
    expect(result.stdout).toContain("--max-evidence-age-hours <hours>");
  });
});
