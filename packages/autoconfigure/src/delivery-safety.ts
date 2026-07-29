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
  createUnverifiedDeliverySafetyResult,
  inspectResidentDaemon,
  type DeliverySafetyCountObservation,
  type DeliverySafetyResult,
  type ResidentDaemonInspection
} from "@muse/runtime-state";
import {
  DELIVERY_SAFETY_REASON,
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

export interface DeliverySafetyTextInspection {
  readonly state: "missing" | "ok" | "unreadable";
  readonly text?: string;
}

export interface DeliverySafetyCollectorDependencies {
  readonly env?: MuseEnvironment;
  readonly now?: () => Date;
  readonly residentInspection?: () => Promise<ResidentDaemonInspection>;
  readonly readText?: (file: string) => Promise<DeliverySafetyTextInspection>;
  readonly inspectLearningHold?: (file: string) => Promise<QualificationLearningHoldInspection>;
  readonly inspectPendingApprovals?: (
    file: string
  ) => Promise<ReadOnlySourceInspection<PendingApprovalSourceSnapshot>>;
}

export interface DeliveryQueueAgeBucket {
  readonly count: number;
  readonly oldestAgeMs: number | null;
}

export interface DeliveryQueueAgeObservation {
  readonly overdue: DeliveryQueueAgeBucket;
  readonly scheduled: DeliveryQueueAgeBucket;
  readonly status: "ok" | "unverified";
}

export interface DeliveryQueueSnapshot {
  readonly followups: DeliveryQueueAgeObservation;
  readonly generatedAt: string;
  readonly pendingDrafts: {
    readonly count: number;
    readonly oldestAgeMs: number | null;
    readonly status: "ok" | "unverified";
  };
  readonly reminders: DeliveryQueueAgeObservation;
  readonly status: "observed" | "unverified";
}

export interface DeliveryQueueSnapshotDependencies {
  readonly env?: MuseEnvironment;
  readonly inspectPendingApprovals?: (
    file: string
  ) => Promise<ReadOnlySourceInspection<PendingApprovalSourceSnapshot>>;
  readonly now?: () => Date;
  readonly readText?: (file: string) => Promise<DeliverySafetyTextInspection>;
}

export type DeliverySafetyProviderResolutionSource =
  | "live-arguments"
  | "persisted-arguments"
  | "effective-runtime-environment"
  | "daemon-config"
  | "default";

export interface DeliverySafetyProviderLockDiagnostic {
  readonly allowedProviderIds: readonly ["log"] | null;
  readonly mismatchReason: typeof DELIVERY_SAFETY_REASON.providerLockMismatch | null;
  readonly resolvedAdapterId: string;
}

/** Privacy-safe compatibility diagnostics; no argument, path, env, payload, or recipient is returned. */
export interface DeliverySafetyDiagnostic {
  readonly baseProviderLocalLog: boolean;
  readonly brakeEngaged: boolean;
  readonly environmentProbe: "ok" | "unverified";
  readonly followups: DeliverySafetyCountObservation;
  readonly localOnly: boolean;
  readonly pendingDrafts: {
    readonly count: number;
    readonly status: "ok" | "unverified";
  };
  readonly providerLockDecision: DeliverySafetyProviderLockDiagnostic;
  readonly providerLockLog: boolean;
  readonly providerResolutionSource: DeliverySafetyProviderResolutionSource;
  readonly reminders: DeliverySafetyCountObservation;
  readonly result: DeliverySafetyResult;
  readonly runtime: ResidentDaemonInspection["observation"] & {
    readonly health: ResidentDaemonInspection["health"];
  };
  readonly selfLearnDisabled: boolean;
  readonly selfLearningHold: QualificationLearningHoldInspection;
}

const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectText(file: string): Promise<DeliverySafetyTextInspection> {
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
  inspect: (file: string) => Promise<DeliverySafetyTextInspection>
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
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!fields) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed);
  const expected = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ];
  const actual = [
    Number(fields[1]),
    Number(fields[2]),
    Number(fields[3]),
    Number(fields[4]),
    Number(fields[5]),
    Number(fields[6]),
    fields[7] === undefined ? 0 : Number(fields[7])
  ];
  return actual.every((field, index) => field === expected[index]) ? parsed : undefined;
}

export async function inspectDeliverySafetyBacklog(
  file: string,
  kind: "followups" | "reminders",
  nowMs: number,
  inspect: (file: string) => Promise<DeliverySafetyTextInspection> = inspectText
): Promise<DeliverySafetyCountObservation> {
  if (!Number.isFinite(nowMs)) {
    return { overdue: 0, scheduled: 0, status: "unverified" };
  }
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

function emptyAgeObservation(status: "ok" | "unverified"): DeliveryQueueAgeObservation {
  return {
    overdue: { count: 0, oldestAgeMs: null },
    scheduled: { count: 0, oldestAgeMs: null },
    status
  };
}

async function inspectDeliveryQueueAges(
  file: string,
  kind: "followups" | "reminders",
  nowMs: number,
  inspect: (file: string) => Promise<DeliverySafetyTextInspection>
): Promise<DeliveryQueueAgeObservation> {
  if (!Number.isSafeInteger(nowMs)) return emptyAgeObservation("unverified");
  const source = await inspect(file);
  if (source.state === "missing") return emptyAgeObservation("ok");
  if (source.state !== "ok" || source.text === undefined) return emptyAgeObservation("unverified");

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text) as unknown;
  } catch {
    return emptyAgeObservation("unverified");
  }
  if (!record(parsed) || !Array.isArray(parsed[kind])) return emptyAgeObservation("unverified");

  const scheduledAges: number[] = [];
  const overdueAges: number[] = [];
  for (const row of parsed[kind]) {
    if (!record(row)) return emptyAgeObservation("unverified");
    const allowedStatuses = kind === "followups"
      ? ["scheduled", "fired", "cancelled"]
      : ["pending", "fired"];
    if (!allowedStatuses.includes(String(row.status))) return emptyAgeObservation("unverified");
    const createdAt = canonicalInstant(row.createdAt);
    const dueAt = canonicalInstant(kind === "followups" ? row.scheduledFor : row.dueAt);
    if (
      createdAt === undefined
      || dueAt === undefined
      || createdAt > nowMs
      || dueAt < createdAt
    ) {
      return emptyAgeObservation("unverified");
    }
    const active = kind === "followups" ? row.status === "scheduled" : row.status === "pending";
    if (!active) continue;
    scheduledAges.push(nowMs - createdAt);
    if (dueAt <= nowMs) overdueAges.push(nowMs - dueAt);
  }

  return {
    overdue: {
      count: overdueAges.length,
      oldestAgeMs: overdueAges.length === 0 ? null : Math.max(...overdueAges)
    },
    scheduled: {
      count: scheduledAges.length,
      oldestAgeMs: scheduledAges.length === 0 ? null : Math.max(...scheduledAges)
    },
    status: "ok"
  };
}

/**
 * Inspect personal delivery queues without invoking a runtime, provider, or
 * mutation-capable store reader. The projection contains only counts and ages.
 */
export async function collectDeliveryQueueSnapshot(
  dependencies: DeliveryQueueSnapshotDependencies = {}
): Promise<DeliveryQueueSnapshot> {
  const env = dependencies.env ?? process.env;
  const inspect = dependencies.readText ?? inspectText;
  const now = (dependencies.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const generatedAt = Number.isSafeInteger(nowMs) ? now.toISOString() : "invalid";
  const [followups, reminders, pending] = await Promise.all([
    inspectDeliveryQueueAges(resolveFollowupsFile(env), "followups", nowMs, inspect),
    inspectDeliveryQueueAges(resolveRemindersFile(env), "reminders", nowMs, inspect),
    (dependencies.inspectPendingApprovals ?? inspectPendingApprovalsSource)(
      resolvePendingApprovalsFile(env)
    ).catch((): ReadOnlySourceInspection<PendingApprovalSourceSnapshot> => ({
      errorCode: "io-error",
      result: "unreadable"
    }))
  ]);

  let pendingDrafts: DeliveryQueueSnapshot["pendingDrafts"];
  if (!Number.isSafeInteger(nowMs)) {
    pendingDrafts = { count: 0, oldestAgeMs: null, status: "unverified" };
  } else if (pending.result === "absent") {
    pendingDrafts = { count: 0, oldestAgeMs: null, status: "ok" };
  } else if (pending.result !== "available" || pending.value.excludedCount !== 0) {
    pendingDrafts = { count: 0, oldestAgeMs: null, status: "unverified" };
  } else {
    const ages: number[] = [];
    for (const row of pending.value.pending) {
      const createdAt = canonicalInstant(row.createdAt);
      if (createdAt === undefined || createdAt > nowMs) {
        ages.length = 0;
        pendingDrafts = { count: 0, oldestAgeMs: null, status: "unverified" };
        break;
      }
      ages.push(nowMs - createdAt);
    }
    pendingDrafts ??= {
      count: ages.length,
      oldestAgeMs: ages.length === 0 ? null : Math.max(...ages),
      status: "ok"
    };
  }

  return {
    followups,
    generatedAt,
    pendingDrafts,
    reminders,
    status: followups.status === "ok"
      && reminders.status === "ok"
      && pendingDrafts.status === "ok"
      ? "observed"
      : "unverified"
  };
}

/**
 * Reduce persisted/live runtime evidence to the sole canonical classifier.
 * Every dependency is an inspection: this collector never writes, starts a
 * service, calls a provider, or sends a message.
 */
export async function collectDeliverySafetyDiagnostic(
  dependencies: DeliverySafetyCollectorDependencies = {}
): Promise<DeliverySafetyDiagnostic> {
  const inspect = dependencies.readText ?? inspectText;
  const resident = await (dependencies.residentInspection
    ? dependencies.residentInspection()
    : inspectResidentDaemon({ env: dependencies.env as NodeJS.ProcessEnv | undefined }));

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
  const providerResolutionSource: DeliverySafetyProviderResolutionSource = liveProvider !== undefined
    ? "live-arguments"
    : persistedProvider !== undefined
      ? "persisted-arguments"
      : environmentProvider !== undefined
        ? "effective-runtime-environment"
        : config.provider !== undefined
          ? "daemon-config"
          : "default";
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
    inspectDeliverySafetyBacklog(resolveFollowupsFile(env), "followups", nowMs, inspect),
    inspectDeliverySafetyBacklog(resolveRemindersFile(env), "reminders", nowMs, inspect),
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
    : pending.result === "absent"
      ? { count: 0, status: "ok" as const }
      : { count: 0, status: "unverified" as const };
  const localOnly = isLocalOnlyEnabled(env);
  const selfLearnRaw = env.MUSE_SELFLEARN_ENABLED;
  const selfLearnDisabled = selfLearnRaw === undefined
    ? false
    : FALSE_VALUES.has(selfLearnRaw.trim().toLowerCase());

  const brakeEngaged = resolveDaemonDeliveryBrake(env).engaged;
  const baseProviderLocalLog = provider === "log";
  const providerLockDecision: DeliverySafetyProviderLockDiagnostic = {
    allowedProviderIds: providerLockLog ? ["log"] : null,
    mismatchReason: providerLockLog && !baseProviderLocalLog
      ? DELIVERY_SAFETY_REASON.providerLockMismatch
      : null,
    resolvedAdapterId: provider
  };
  const result = classifyDeliverySafety({
    baseProviderLocal: baseProviderLocalLog,
    deliveryBrake: brakeEngaged ? "engaged" : "released",
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
  return {
    baseProviderLocalLog,
    brakeEngaged,
    environmentProbe,
    followups,
    localOnly,
    pendingDrafts,
    providerLockDecision,
    providerLockLog,
    providerResolutionSource,
    reminders,
    result,
    runtime: { ...resident.observation, health: resident.health },
    selfLearnDisabled,
    selfLearningHold: hold
  };
}

/** Public fail-closed boundary: dependency diagnostics never escape or reveal raw owner evidence. */
export async function collectDeliverySafety(
  dependencies: DeliverySafetyCollectorDependencies = {}
): Promise<DeliverySafetyResult> {
  try {
    return (await collectDeliverySafetyDiagnostic(dependencies)).result;
  } catch {
    return createUnverifiedDeliverySafetyResult();
  }
}
