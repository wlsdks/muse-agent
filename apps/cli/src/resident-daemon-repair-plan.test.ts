import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ResidentDaemonHealthResult,
  ResidentMuseProcess
} from "@muse/runtime-state";

import {
  applyResidentDaemonRepairPlan,
  buildResidentDaemonRepairPlan,
  parseResidentDaemonRepairPlan,
  residentDaemonRepairSnapshotHash,
  type ResidentDaemonRepairSnapshot
} from "./resident-daemon-repair-plan.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const PROCESS: ResidentMuseProcess = {
  cwd: "/Applications/Muse",
  executableRealpath: process.execPath,
  matchesLaunchdPid: true,
  pid: 4321,
  ppid: 1,
  role: "resident",
  startedAt: "2026-07-25T23:00:00.000Z"
};

function snapshot(overrides: {
  readonly health?: ResidentDaemonHealthResult;
  readonly pid?: number;
  readonly runtime?: "running" | "crash-looping";
} = {}): ResidentDaemonRepairSnapshot {
  const health = overrides.health ?? {
    reasonCodes: ["daemon-heartbeat-stale"],
    status: "failed"
  };
  const pid = overrides.pid ?? 4321;
  return {
    autostart: {
      artifact: { entrypoint: "/Applications/Muse/index.js", state: "valid" },
      kind: "darwin",
      plistFile: "/Users/owner/Library/LaunchAgents/com.muse.daemon.plist",
      runtime: overrides.runtime === "crash-looping"
        ? { lastExitStatus: 1, state: "crash-looping" }
        : { pid, state: "running" }
    },
    desired: {
      cliEntry: "/Applications/Muse/index.js",
      runtimeExecutable: process.execPath,
      state: "valid"
    },
    health,
    processes: [{ ...PROCESS, pid }]
  };
}

function missingSnapshot(): ResidentDaemonRepairSnapshot {
  return {
    autostart: {
      artifact: { state: "missing" },
      kind: "darwin",
      plistFile: "/Users/owner/Library/LaunchAgents/com.muse.daemon.plist",
      runtime: { state: "not-registered" }
    },
    desired: {
      cliEntry: "/Applications/Muse/index.js",
      runtimeExecutable: process.execPath,
      state: "valid"
    },
    health: {
      reasonCodes: ["daemon-not-registered", "daemon-artifact-missing"],
      status: "failed"
    },
    processes: []
  };
}

describe("resident daemon repair plan", () => {
  it("builds deterministic exact targets without mutating or exposing environment", () => {
    const input = missingSnapshot();
    const env = {
      HOME: "/Users/owner",
      MUSE_SECRET_TOKEN: "must-not-appear"
    };
    const first = buildResidentDaemonRepairPlan({ env, now: NOW, snapshot: input });
    const second = buildResidentDaemonRepairPlan({ env, now: NOW, snapshot: input });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      disposition: "repairable",
      steps: [{
        id: "reinstall-autostart",
        target: {
          artifact: "/Users/owner/Library/LaunchAgents/com.muse.daemon.plist",
          cliEntry: "/Applications/Muse/index.js",
          label: "com.muse.daemon",
          platform: "darwin",
          processIds: [],
          runtimeExecutable: process.execPath
        }
      }]
    });
    expect(JSON.stringify(first)).not.toContain("must-not-appear");
    expect(parseResidentDaemonRepairPlan(JSON.stringify(first), NOW)).toEqual(first);
  });

  it("rejects tampered, future, expired, partial, and unknown plans", () => {
    const plan = buildResidentDaemonRepairPlan({ env: { HOME: "/Users/owner" }, now: NOW, snapshot: missingSnapshot() });
    const variants = [
      { ...plan, private: true },
      { ...plan, beforeHash: "0".repeat(64) },
      { ...plan, createdAt: "2099-01-01T00:00:00.000Z" },
      { ...plan, expiresAt: NOW.toISOString() },
      { ...plan, steps: [] },
      { ...plan, target: { ...plan.target, processIds: [0] } }
    ];
    for (const variant of variants) {
      expect(parseResidentDaemonRepairPlan(JSON.stringify(variant), NOW)).toBeUndefined();
    }
    expect(parseResidentDaemonRepairPlan("{\"schemaVersion\":", NOW)).toBeUndefined();
  });

  it("is effect-free for healthy, unmanaged, stale, and expired observations", async () => {
    const execute = vi.fn(async () => true);
    const healthySnapshot = snapshot({
      health: { reasonCodes: [], status: "healthy" }
    });
    const healthy = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: healthySnapshot
    });
    expect(await applyResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      execute,
      now: NOW,
      plan: healthy,
      snapshot: healthySnapshot
    })).toBe("no-op");
    expect(await applyResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      execute,
      now: new Date(NOW.getTime() + 1),
      plan: healthy,
      snapshot: snapshot({ health: { reasonCodes: [], status: "healthy" }, pid: 9876 })
    })).toBe("stale");

    const base = missingSnapshot();
    const plan = buildResidentDaemonRepairPlan({ env: { HOME: "/Users/owner" }, now: NOW, snapshot: base });
    expect(await applyResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      execute,
      now: new Date(NOW.getTime() + 1),
      plan,
      snapshot: { ...base, health: { reasonCodes: ["daemon-artifact-missing"], status: "failed" } }
    })).toBe("stale");
    expect(await applyResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      execute,
      now: new Date(Date.parse(plan.expiresAt)),
      plan,
      snapshot: base
    })).toBe("stale");
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes only the immutable planned step after an exact current recheck", async () => {
    const current = missingSnapshot();
    const plan = buildResidentDaemonRepairPlan({ env: { HOME: "/Users/owner" }, now: NOW, snapshot: current });
    const execute = vi.fn(async () => true);

    expect(residentDaemonRepairSnapshotHash(current)).toBe(plan.beforeHash);
    expect(await applyResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      execute,
      now: new Date(NOW.getTime() + 1),
      plan,
      snapshot: current
    })).toBe("applied");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(plan.steps[0]);
  });

  it("blocks automatic repair when an exact process target is not owned by the service manager", () => {
    const current = snapshot();
    const plan = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: {
        ...current,
        processes: [{
          ...PROCESS,
          matchesLaunchdPid: false,
          role: "orphan-api"
        }]
      }
    });

    expect(plan).toMatchObject({
      disposition: "blocked",
      reasonCodes: expect.arrayContaining(["daemon-repair-process-targets-require-manual-stop"]),
      steps: [],
      target: { processIds: [4321] }
    });
  });

  it("canonicalizes reason order and every duplicate-PID process tie", () => {
    const firstProcess = {
      ...PROCESS,
      cwd: "/a",
      executableRealpath: "/runtime/a",
      matchesLaunchdPid: false,
      role: "orphan-api" as const
    };
    const secondProcess = {
      ...PROCESS,
      cwd: "/b",
      executableRealpath: "/runtime/b",
      matchesLaunchdPid: false,
      role: "orphan-api" as const
    };
    const base = snapshot({
      health: {
        reasonCodes: ["daemon-restart-state-missing", "daemon-heartbeat-stale"],
        status: "failed"
      }
    });
    const left = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: { ...base, processes: [firstProcess, secondProcess] }
    });
    const right = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: {
        ...base,
        health: {
          reasonCodes: ["daemon-heartbeat-stale", "daemon-restart-state-missing"],
          status: "failed"
        },
        processes: [secondProcess, firstProcess]
      }
    });

    expect(left.beforeHash).toBe(right.beforeHash);
    expect(left.planHash).toBe(right.planHash);
    expect(left.reasonCodes).toEqual([
      "daemon-heartbeat-stale",
      "daemon-repair-process-targets-require-manual-stop",
      "daemon-restart-state-missing"
    ]);
  });

  it("rebuilds expected semantics so a rehashed no-op-to-repair forgery stays effect-free", async () => {
    const current = snapshot({
      health: { reasonCodes: [], status: "healthy" }
    });
    const original = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: current
    });
    const forgedBody = {
      applyCommand: original.applyCommand,
      beforeHash: original.beforeHash,
      createdAt: original.createdAt,
      disposition: "repairable" as const,
      expiresAt: original.expiresAt,
      reasonCodes: ["attacker-requested-repair"],
      schemaVersion: original.schemaVersion,
      steps: [{
        effect: "service-manager-and-artifact" as const,
        id: "reinstall-autostart" as const,
        reversible: true as const,
        rollback: "muse daemon --uninstall",
        target: original.target
      }],
      target: original.target
    };
    const forged = {
      ...forgedBody,
      planHash: createHash("sha256").update(JSON.stringify(forgedBody)).digest("hex")
    };
    expect(parseResidentDaemonRepairPlan(JSON.stringify(forged), NOW)).toEqual(forged);
    const execute = vi.fn(async () => true);

    expect(await applyResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      execute,
      now: NOW,
      plan: forged,
      snapshot: current
    })).toBe("stale");
    expect(execute).not.toHaveBeenCalled();
  });

  it("repairs a valid existing artifact through Task021's versioned backup transaction", () => {
    const plan = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: snapshot()
    });

    expect(plan).toMatchObject({
      disposition: "repairable",
      reasonCodes: expect.arrayContaining(["daemon-heartbeat-stale"]),
      steps: [expect.objectContaining({ id: "reinstall-autostart", reversible: true })]
    });
  });

  it("does not call a missing plist an absent service while launchd or a process still exists", () => {
    const absent = missingSnapshot();
    const stillLoaded = buildResidentDaemonRepairPlan({
      env: { HOME: "/Users/owner" },
      now: NOW,
      snapshot: {
        ...absent,
        autostart: {
          artifact: { state: "missing" },
          kind: "darwin",
          plistFile: "/Users/owner/Library/LaunchAgents/com.muse.daemon.plist",
          runtime: { pid: 4321, state: "running" }
        },
        processes: [PROCESS]
      }
    });

    expect(stillLoaded).toMatchObject({
      disposition: "blocked",
      reasonCodes: expect.arrayContaining(["daemon-repair-requires-versioned-backup"]),
      steps: []
    });
  });

  it("fails closed when the later shared-health probe contradicts an earlier missing artifact probe", () => {
    const absent = missingSnapshot();
    for (const reasonCode of [
      "daemon-artifact-stale",
      "daemon-artifact-invalid",
      "daemon-not-running"
    ] as const) {
      const plan = buildResidentDaemonRepairPlan({
        env: { HOME: "/Users/owner" },
        now: NOW,
        snapshot: {
          ...absent,
          health: {
            reasonCodes: [reasonCode],
            status: "failed"
          }
        }
      });
      expect(plan).toMatchObject({
        disposition: "blocked",
        reasonCodes: expect.arrayContaining(["daemon-repair-requires-versioned-backup"]),
        steps: []
      });
    }
  });
});
