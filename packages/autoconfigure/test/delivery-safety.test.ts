import { describe, expect, it, vi } from "vitest";

import type { ResidentDaemonInspection } from "@muse/runtime-state";
import { DELIVERY_SAFETY_REASON, type ReadOnlySourceInspection } from "@muse/shared";
import type { PendingApprovalSourceSnapshot } from "@muse/messaging";
import type { QualificationLearningHoldInspection } from "@muse/stores";

import {
  collectDeliverySafety,
  collectDeliverySafetyDiagnostic,
  createApiServerOptions,
  type DeliverySafetyCollectorDependencies,
  type MuseEnvironment
} from "../src/index.js";

const NOW = new Date("2026-07-27T00:00:00.000Z");

function resident(
  env: MuseEnvironment,
  options: {
    readonly liveArguments?: readonly string[];
    readonly diskArguments?: readonly string[];
    readonly liveDefinitionMatches?: boolean;
  } = {}
): ResidentDaemonInspection {
  return {
    diskArguments: options.diskArguments ?? ["/node", "/muse.js", "daemon", "--provider", "log"],
    effectiveRuntimeEnv: env as NodeJS.ProcessEnv,
    liveArguments: options.liveArguments ?? ["/node", "/muse.js", "daemon", "--provider", "log"],
    liveEnvironment: { MUSE_LOCAL_ONLY: "true" },
    observation: {
      liveDefinitionMatches: options.liveDefinitionMatches ?? true
    }
  } as ResidentDaemonInspection;
}

function syntheticDependencies(
  env: MuseEnvironment,
  options: {
    readonly daemonConfig?: string;
    readonly followups?: string;
    readonly reminders?: string;
    readonly inspection?: ResidentDaemonInspection;
    readonly hold?: QualificationLearningHoldInspection;
    readonly pending?: ReadOnlySourceInspection<PendingApprovalSourceSnapshot>;
  } = {}
): DeliverySafetyCollectorDependencies {
  return {
    env,
    inspectLearningHold: async () => options.hold ?? ({ engaged: true, record: {
      active: true,
      activatedAt: NOW.toISOString(),
      holdId: "synthetic-hold",
      reason: "personal-agent-qualification",
      schemaVersion: 1
    }, state: "active" }),
    inspectPendingApprovals: async () => options.pending ?? ({
      result: "available",
      value: { excludedCount: 0, pending: [] }
    }),
    now: () => NOW,
    readText: async (file) => {
      if (file.endsWith("daemon.json")) {
        return options.daemonConfig === undefined
          ? { state: "missing" }
          : { state: "ok", text: options.daemonConfig };
      }
      if (file.endsWith("followups.json")) {
        return { state: "ok", text: options.followups ?? '{"followups":[]}' };
      }
      if (file.endsWith("reminders.json")) {
        return { state: "ok", text: options.reminders ?? '{"reminders":[]}' };
      }
      return { state: "missing" };
    },
    residentInspection: async () => options.inspection ?? resident(env)
  };
}

function greenEnvironment(): MuseEnvironment {
  return {
    HOME: "/synthetic-owner-secret",
    MUSE_DAEMON_CONFIG_FILE: "/synthetic-owner-secret/daemon.json",
    MUSE_DAEMON_DELIVERY_ENABLED: "true",
    MUSE_DAEMON_PROVIDER_LOCK: "log",
    MUSE_LOCAL_ONLY: "true",
    MUSE_PROACTIVE_PROVIDER: "log",
    MUSE_SELFLEARN_ENABLED: "false",
    MUSE_SCHEDULER_PERSIST: "false",
    MUSE_TASK_MEMORY_PERSIST: "false"
  };
}

describe("collectDeliverySafety", () => {
  it("projects a fully synthetic green fixture through the canonical classifier", async () => {
    const result = await collectDeliverySafety(syntheticDependencies(greenEnvironment()));

    expect(result).toMatchObject({ reasonCodes: [], status: "passed" });
    expect(JSON.stringify(result)).not.toContain("synthetic-owner-secret");
  });

  it("reports the canonical brake reason without leaking raw fixture values", async () => {
    const env = { ...greenEnvironment(), MUSE_DAEMON_DELIVERY_ENABLED: "false" };
    const result = await collectDeliverySafety(syntheticDependencies(env));

    expect(result.status).toBe("unverified");
    expect(result.reasonCodes).toContain(DELIVERY_SAFETY_REASON.deliveryBrakeEngaged);
    expect(JSON.stringify(result)).not.toContain(env.HOME);
  });

  it("fails an exact log lock resolved to a different live provider", async () => {
    const env = greenEnvironment();
    const inspection = resident(env, {
      liveArguments: ["/node", "/muse.js", "daemon", "--provider", "fixture-cloud-secret"]
    });
    const result = await collectDeliverySafety(syntheticDependencies(env, { inspection }));

    expect(result.status).toBe("failed");
    expect(result.reasonCodes).toContain(DELIVERY_SAFETY_REASON.providerLockMismatch);
    expect(JSON.stringify(result)).not.toContain("fixture-cloud-secret");
  });

  it("fails closed for malformed backlog and daemon configuration evidence", async () => {
    const result = await collectDeliverySafety(syntheticDependencies(greenEnvironment(), {
      daemonConfig: '{"provider":42}',
      followups: '{"followups":[{"status":"scheduled","scheduledFor":"not-a-date"}]}',
      reminders: '{"reminders":[{"status":"pending","dueAt":"2026-02-30T00:00:00.000Z"}]}'
    }));

    expect(result.status).toBe("unverified");
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      DELIVERY_SAFETY_REASON.environmentUnverified,
      DELIVERY_SAFETY_REASON.followupBacklogUnverified,
      DELIVERY_SAFETY_REASON.reminderBacklogUnverified
    ]));
  });

  it("converts inspection exceptions to a privacy-safe unverified result", async () => {
    const residentFailure = await collectDeliverySafety({
      residentInspection: async () => {
        throw new Error("raw-owner-secret");
      }
    });
    const env = greenEnvironment();
    const sourceFailure = await collectDeliverySafety({
      ...syntheticDependencies(env),
      readText: async () => {
        throw new Error("raw-source-secret");
      }
    });

    expect(residentFailure.status).toBe("unverified");
    expect(sourceFailure.status).toBe("unverified");
    expect(JSON.stringify([residentFailure, sourceFailure])).not.toMatch(/raw-(?:owner|source)-secret/u);
  });

  it.each([
    {
      source: "live-arguments",
      setup: (env: MuseEnvironment) => resident(env, {
        diskArguments: ["/node", "/muse.js", "daemon", "--provider", "disk"],
        liveArguments: ["/node", "/muse.js", "daemon", "--provider", "live"]
      }),
      value: "live"
    },
    {
      source: "persisted-arguments",
      setup: (env: MuseEnvironment) => ({
        ...resident(env, { diskArguments: ["/node", "/muse.js", "daemon", "--provider", "disk"] }),
        liveArguments: ["/node", "/muse.js", "daemon"]
      }),
      value: "disk"
    },
    {
      source: "effective-runtime-environment",
      setup: (env: MuseEnvironment) => ({
        ...resident(env),
        diskArguments: ["/node", "/muse.js", "daemon"],
        liveArguments: ["/node", "/muse.js", "daemon"]
      }),
      value: "environment"
    },
    {
      source: "daemon-config",
      setup: (env: MuseEnvironment) => ({
        ...resident(env),
        diskArguments: ["/node", "/muse.js", "daemon"],
        effectiveRuntimeEnv: { ...env, MUSE_PROACTIVE_PROVIDER: undefined },
        liveArguments: ["/node", "/muse.js", "daemon"]
      }),
      value: "config"
    },
    {
      source: "default",
      setup: (env: MuseEnvironment) => ({
        ...resident(env),
        diskArguments: ["/node", "/muse.js", "daemon"],
        effectiveRuntimeEnv: { ...env, MUSE_PROACTIVE_PROVIDER: undefined },
        liveArguments: ["/node", "/muse.js", "daemon"]
      }),
      value: "log"
    }
  ] as const)("uses $source in strict provider precedence", async ({ setup, source, value }) => {
    const env = { ...greenEnvironment(), MUSE_PROACTIVE_PROVIDER: "environment" };
    const diagnostic = await collectDeliverySafetyDiagnostic(syntheticDependencies(env, {
      daemonConfig: source === "default" ? undefined : '{"provider":"config"}',
      inspection: setup(env) as ResidentDaemonInspection
    }));

    expect(diagnostic.providerResolutionSource).toBe(source);
    expect(diagnostic.providerLockDecision.resolvedAdapterId).toBe(value);
  });

  it.each([" ", "telegram"])("treats a %j provider lock as ambiguous and unverified", async (lock) => {
    const env = { ...greenEnvironment(), MUSE_DAEMON_PROVIDER_LOCK: lock };
    const diagnostic = await collectDeliverySafetyDiagnostic(syntheticDependencies(env));

    expect(diagnostic.environmentProbe).toBe("unverified");
    expect(diagnostic.providerLockLog).toBe(false);
    expect(diagnostic.result.reasonCodes).toContain(DELIVERY_SAFETY_REASON.providerLockUnverified);
  });

  it("counts positive backlogs and treats an occurrence exactly at now as overdue", async () => {
    const diagnostic = await collectDeliverySafetyDiagnostic(syntheticDependencies(greenEnvironment(), {
      followups: JSON.stringify({ followups: [
        { scheduledFor: NOW.toISOString(), status: "scheduled" },
        { scheduledFor: "2026-07-28T00:00:00Z", status: "scheduled" }
      ] }),
      reminders: JSON.stringify({ reminders: [
        { dueAt: NOW.toISOString(), status: "pending" },
        { dueAt: "2026-07-26T00:00:00Z", status: "pending" }
      ] })
    }));

    expect(diagnostic.followups).toEqual({ overdue: 1, scheduled: 2, status: "ok" });
    expect(diagnostic.reminders).toEqual({ overdue: 2, scheduled: 2, status: "ok" });
  });

  it.each([
    ["active", { engaged: true, record: {
      active: true, activatedAt: NOW.toISOString(), holdId: "active-hold",
      reason: "personal-agent-qualification", schemaVersion: 1
    }, state: "active" }, undefined],
    ["released", { engaged: false, state: "inactive" }, DELIVERY_SAFETY_REASON.selfLearningHoldMissing],
    ["invalid", { engaged: true, failure: "invalid-schema", state: "invalid" }, DELIVERY_SAFETY_REASON.selfLearningHoldUnverified],
    ["missing", { engaged: false, state: "inactive" }, DELIVERY_SAFETY_REASON.selfLearningHoldMissing]
  ] as const)("preserves %s learning-hold diagnostics", async (_name, hold, reason) => {
    const diagnostic = await collectDeliverySafetyDiagnostic(syntheticDependencies(greenEnvironment(), {
      hold: hold as QualificationLearningHoldInspection
    }));

    expect(diagnostic.selfLearningHold).toEqual(hold);
    if (reason) expect(diagnostic.result.reasonCodes).toContain(reason);
    else expect(diagnostic.result.reasonCodes).not.toContain(DELIVERY_SAFETY_REASON.selfLearningHoldMissing);
  });

  it.each([
    ["available", { result: "available", value: { excludedCount: 0, pending: [] } }, "ok"],
    ["missing", { errorCode: "missing", result: "absent" }, "unverified"],
    ["unreadable", { errorCode: "io-error", result: "unreadable" }, "unverified"],
    ["excluded", { result: "available", value: { excludedCount: 1, pending: [] } }, "unverified"]
  ] as const)("reduces a %s pending source without exposing records", async (_name, pending, status) => {
    const diagnostic = await collectDeliverySafetyDiagnostic(syntheticDependencies(greenEnvironment(), {
      pending: pending as ReadOnlySourceInspection<PendingApprovalSourceSnapshot>
    }));

    expect(diagnostic.pendingDrafts.status).toBe(status);
    expect(JSON.stringify(diagnostic)).not.toMatch(/destination|payload|recipient/iu);
  });

  it("suppresses delivery-dependent failures under the brake but never suppresses a lock mismatch", async () => {
    const env = {
      ...greenEnvironment(),
      MUSE_DAEMON_DELIVERY_ENABLED: "false",
      MUSE_LOCAL_ONLY: "false",
      MUSE_SELFLEARN_ENABLED: "true"
    };
    const inspection = resident(env, {
      liveArguments: ["/node", "/muse.js", "daemon", "--provider", "remote"]
    });
    const result = await collectDeliverySafety(syntheticDependencies(env, {
      hold: { engaged: false, state: "inactive" },
      inspection
    }));

    expect(result.status).toBe("failed");
    expect(result.reasonCodes).toContain(DELIVERY_SAFETY_REASON.providerLockMismatch);
    expect(result.reasonCodes).not.toEqual(expect.arrayContaining([
      DELIVERY_SAFETY_REASON.localOnlyMissing,
      DELIVERY_SAFETY_REASON.selfLearnEnabled,
      DELIVERY_SAFETY_REASON.deliveryRouteNotLocal,
      DELIVERY_SAFETY_REASON.selfLearningHoldMissing
    ]));
  });
});

describe("createApiServerOptions delivery safety", () => {
  it("exposes a production-default lazy supplier and invokes injected collection only on demand", async () => {
    const env = greenEnvironment();
    const residentInspection = vi.fn(async () => resident(env));
    const options = createApiServerOptions({
      deliverySafetyDependencies: {
        ...syntheticDependencies(env),
        residentInspection
      },
      env
    });

    expect(options.deliverySafety).toBeTypeOf("function");
    expect(residentInspection).not.toHaveBeenCalled();
    expect((await options.deliverySafety()).status).toBe("passed");
    expect(residentInspection).toHaveBeenCalledTimes(1);

    const production = createApiServerOptions({
      env: {
        MUSE_SCHEDULER_PERSIST: "false",
        MUSE_TASK_MEMORY_PERSIST: "false"
      }
    });
    expect(production.deliverySafety).toBeTypeOf("function");
  });
});
