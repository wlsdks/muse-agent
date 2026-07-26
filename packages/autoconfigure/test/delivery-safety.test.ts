import { describe, expect, it, vi } from "vitest";

import type { ResidentDaemonInspection } from "@muse/runtime-state";
import { DELIVERY_SAFETY_REASON } from "@muse/shared";

import {
  collectDeliverySafety,
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
  } = {}
): DeliverySafetyCollectorDependencies {
  return {
    env,
    inspectLearningHold: async () => ({ engaged: true, record: {
      active: true,
      activatedAt: NOW.toISOString(),
      holdId: "synthetic-hold",
      reason: "personal-agent-qualification",
      schemaVersion: 1
    }, state: "active" }),
    inspectPendingApprovals: async () => ({
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
