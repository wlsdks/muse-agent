/** Read-only production collector for the provider-neutral delivery-safety projection. */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  inspectPendingApprovalsSource,
  type PendingApprovalSourceSnapshot
} from "@muse/messaging";
import { isLocalOnlyEnabled } from "@muse/model";
import {
  classifyDeliverySafety,
  inspectResidentDaemon,
  type DeliverySafetyCountObservation,
  type DeliverySafetyObservation,
  type DeliverySafetyResult,
  type ResidentDaemonInspection
} from "@muse/runtime-state";
import {
  resolveDaemonDeliveryBrake,
  type ReadOnlySourceInspection
} from "@muse/shared";
import {
  inspectQualificationLearningHold,
  type QualificationLearningHoldInspection
} from "@muse/stores";

import {
  resolveFollowupsFile,
  resolvePendingApprovalsFile,
  resolveQualificationLearningHoldFile,
  resolveRemindersFile
} from "./personal-providers.js";
import type { MuseEnvironment } from "./runtime-assembly.js";

interface TextInspection {
  readonly state: "missing" | "ok" | "unreadable";
  readonly text?: string;
}

export interface DeliverySafetyCollectorDependencies {
  readonly env?: MuseEnvironment;
  readonly now?: () => Date;
  readonly residentInspection?: () => Promise<ResidentDaemonInspection>;
  readonly readText?: (file: string) => Promise<TextInspection>;
  readonly inspectLearningHold?: (file: string) => Promise<QualificationLearningHoldInspection>;
  readonly inspectPendingApprovals?: (
    file: string
  ) => Promise<ReadOnlySourceInspection<PendingApprovalSourceSnapshot>>;
}

const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectText(file: string): Promise<TextInspection> {
  try {
    return { state: "ok", text: await readFile(file, "utf8") };
  } catch (cause) {
    return cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }
}

function resolveDaemonConfigFile(env: MuseEnvironment): string {
  const explicit = env.MUSE_DAEMON_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  return join(env.HOME?.trim() || homedir(), ".config", "muse", "daemon.json");
}

async function inspectDaemonConfigProvider(
  file: string,
  inspect: (file: string) => Promise<TextInspection>
): Promise<{ readonly status: "ok" | "unverified"; readonly provider?: string }> {
  const source = await inspect(file);
  if (source.state === "missing") return { status: "ok" };
  if (source.state !== "ok" || source.text === undefined) return { status: "unverified" };
  try {
    const parsed = JSON.parse(source.text) as unknown;
    if (!record(parsed)) return { status: "unverified" };
    if (parsed.provider === undefined) return { status: "ok" };
    if (typeof parsed.provider !== "string" || parsed.provider.trim().length === 0) {
      return { status: "unverified" };
    }
    return { provider: parsed.provider.trim(), status: "ok" };
  } catch {
    return { status: "unverified" };
  }
}

function providerFlag(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--provider") return args[index + 1]?.trim() || undefined;
    if (argument.startsWith("--provider=")) {
      return argument.slice("--provider=".length).trim() || undefined;
    }
  }
  return undefined;
}

function canonicalInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

async function inspectBacklog(
  file: string,
  kind: "followups" | "reminders",
  nowMs: number,
  inspect: (file: string) => Promise<TextInspection>
): Promise<DeliverySafetyCountObservation> {
  const source = await inspect(file);
  if (source.state === "missing") return { overdue: 0, scheduled: 0, status: "ok" };
  if (source.state !== "ok" || source.text === undefined) {
    return { overdue: 0, scheduled: 0, status: "unverified" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text) as unknown;
  } catch {
    return { overdue: 0, scheduled: 0, status: "unverified" };
  }
  if (!record(parsed) || !Array.isArray(parsed[kind])) {
    return { overdue: 0, scheduled: 0, status: "unverified" };
  }
  let scheduled = 0;
  let overdue = 0;
  for (const row of parsed[kind]) {
    if (!record(row)) return { overdue: 0, scheduled: 0, status: "unverified" };
    if (kind === "followups") {
      if (!["scheduled", "fired", "cancelled"].includes(String(row.status))) {
        return { overdue: 0, scheduled: 0, status: "unverified" };
      }
      if (row.status !== "scheduled") continue;
      const at = canonicalInstant(row.scheduledFor);
      if (at === undefined) return { overdue: 0, scheduled: 0, status: "unverified" };
      scheduled += 1;
      if (at <= nowMs) overdue += 1;
    } else {
      if (!["pending", "fired"].includes(String(row.status))) {
        return { overdue: 0, scheduled: 0, status: "unverified" };
      }
      if (row.status !== "pending") continue;
      const at = canonicalInstant(row.dueAt);
      if (at === undefined) return { overdue: 0, scheduled: 0, status: "unverified" };
      scheduled += 1;
      if (at <= nowMs) overdue += 1;
    }
  }
  return { overdue, scheduled, status: "ok" };
}

function unverifiedObservation(): DeliverySafetyObservation {
  return {
    baseProviderLocal: "unverified",
    // A collector failure must not let a missing observation imply delivery
    // eligibility. Treat the brake as engaged while preserving unverified
    // evidence for every underlying fact.
    deliveryBrake: "engaged",
    environmentProbe: "unverified",
    followups: { overdue: 0, scheduled: 0, status: "unverified" },
    localOnlyEffective: "unverified",
    localOnlyPersisted: "unverified",
    pendingDrafts: { count: 0, status: "unverified" },
    providerLock: { localOnly: false, mismatch: false, observation: "unverified" },
    reminders: { overdue: 0, scheduled: 0, status: "unverified" },
    selfLearnDisabled: "unverified",
    selfLearningHold: "unverified"
  };
}

/**
 * Reduce persisted/live runtime evidence to the sole canonical classifier.
 * Every dependency is an inspection: this collector never writes, starts a
 * service, calls a provider, or sends a message.
 */
async function collectDeliverySafetyResult(
  dependencies: DeliverySafetyCollectorDependencies = {}
): Promise<DeliverySafetyResult> {
  const inspect = dependencies.readText ?? inspectText;
  let resident: ResidentDaemonInspection;
  try {
    resident = await (dependencies.residentInspection
      ? dependencies.residentInspection()
      : inspectResidentDaemon({ env: dependencies.env as NodeJS.ProcessEnv | undefined }));
  } catch {
    return classifyDeliverySafety(unverifiedObservation());
  }

  const env = resident.effectiveRuntimeEnv;
  const nowMs = (dependencies.now ?? (() => new Date()))().getTime();
  const config = await inspectDaemonConfigProvider(resolveDaemonConfigFile(env), inspect);
  const liveProvider = providerFlag(resident.liveArguments);
  const persistedProvider = providerFlag(resident.diskArguments);
  const environmentProviderRaw = env.MUSE_PROACTIVE_PROVIDER;
  const environmentProvider = environmentProviderRaw?.trim() || undefined;
  const environmentAmbiguous = environmentProviderRaw !== undefined && environmentProvider === undefined;
  const provider = liveProvider
    ?? persistedProvider
    ?? environmentProvider
    ?? config.provider
    ?? "log";
  const lockRaw = env.MUSE_DAEMON_PROVIDER_LOCK;
  const providerLockLog = lockRaw?.trim() === "log";
  const providerLockAmbiguous = lockRaw !== undefined && !providerLockLog;
  const environmentProbe = resident.liveEnvironment !== undefined
    && resident.liveArguments !== undefined
    && resident.observation.liveDefinitionMatches
    && config.status === "ok"
    && !environmentAmbiguous
    && !providerLockAmbiguous
    ? "ok" as const
    : "unverified" as const;

  const [followups, reminders, hold, pending] = await Promise.all([
    inspectBacklog(resolveFollowupsFile(env), "followups", nowMs, inspect),
    inspectBacklog(resolveRemindersFile(env), "reminders", nowMs, inspect),
    (dependencies.inspectLearningHold ?? inspectQualificationLearningHold)(
      resolveQualificationLearningHoldFile(env)
    ).catch((): QualificationLearningHoldInspection => ({
      engaged: true,
      failure: "unreadable",
      state: "invalid"
    })),
    (dependencies.inspectPendingApprovals ?? inspectPendingApprovalsSource)(
      resolvePendingApprovalsFile(env)
    ).catch((): ReadOnlySourceInspection<PendingApprovalSourceSnapshot> => ({
      errorCode: "io-error",
      result: "unreadable"
    }))
  ]);
  const pendingDrafts = pending.result === "available" && pending.value.excludedCount === 0
    ? { count: pending.value.pending.length, status: "ok" as const }
    : { count: 0, status: "unverified" as const };
  const localOnly = isLocalOnlyEnabled(env);
  const selfLearnRaw = env.MUSE_SELFLEARN_ENABLED;
  const selfLearnDisabled = selfLearnRaw === undefined
    ? false
    : FALSE_VALUES.has(selfLearnRaw.trim().toLowerCase());

  return classifyDeliverySafety({
    baseProviderLocal: provider === "log",
    deliveryBrake: resolveDaemonDeliveryBrake(env).engaged ? "engaged" : "released",
    environmentProbe,
    followups,
    localOnlyEffective: localOnly,
    localOnlyPersisted: localOnly,
    pendingDrafts,
    providerLock: {
      localOnly: providerLockLog,
      mismatch: providerLockLog && provider !== "log",
      observation: environmentProbe === "ok" ? "verified" : "unverified"
    },
    reminders,
    selfLearnDisabled,
    selfLearningHold: hold.state === "invalid"
      ? "unverified"
      : hold.engaged ? "engaged" : "released"
  });
}

/** Public fail-closed boundary: dependency diagnostics never escape or reveal raw owner evidence. */
export async function collectDeliverySafety(
  dependencies: DeliverySafetyCollectorDependencies = {}
): Promise<DeliverySafetyResult> {
  try {
    return await collectDeliverySafetyResult(dependencies);
  } catch {
    return classifyDeliverySafety(unverifiedObservation());
  }
}
