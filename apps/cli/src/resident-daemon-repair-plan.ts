import { createHash } from "node:crypto";

import type {
  ResidentDaemonHealthResult,
  ResidentMuseProcess
} from "@muse/runtime-state";

import {
  LAUNCH_AGENT_LABEL,
  resolveLaunchAgentFile
} from "./commands-daemon-launchagent.js";
import {
  SCHTASKS_TASK_NAME
} from "./commands-daemon-schtasks.js";
import type { DaemonAutostartStatus } from "./commands-daemon-autostart.js";

export const DAEMON_REPAIR_PLAN_SCHEMA = "muse.daemon-repair-plan/v1";
export const DAEMON_REPAIR_PLAN_MAX_AGE_MS = 15 * 60_000;

type RepairPlatform = "darwin" | "win32" | "unmanaged";
type RepairDisposition = "no-op" | "repairable" | "blocked";

export interface ResidentDaemonRepairSnapshot {
  readonly autostart: DaemonAutostartStatus;
  readonly desired:
    | {
        readonly cliEntry: string;
        readonly runtimeExecutable: string;
        readonly state: "valid";
      }
    | {
        readonly reasonCode: "daemon-repair-install-target-invalid";
        readonly state: "invalid";
      };
  readonly health: ResidentDaemonHealthResult;
  readonly processes: readonly ResidentMuseProcess[];
}

export interface ResidentDaemonRepairTarget {
  readonly artifact: string;
  readonly cliEntry: string | null;
  readonly label: string;
  readonly platform: RepairPlatform;
  readonly processIds: readonly number[];
  readonly runtimeExecutable: string | null;
}

export interface ResidentDaemonRepairStep {
  readonly id: "reinstall-autostart";
  readonly effect: "service-manager-and-artifact";
  readonly reversible: true;
  readonly rollback: string;
  readonly target: ResidentDaemonRepairTarget;
}

export interface ResidentDaemonRepairPlan {
  readonly applyCommand: "muse daemon --apply-repair-plan <plan-file>";
  readonly beforeHash: string;
  readonly createdAt: string;
  readonly disposition: RepairDisposition;
  readonly expiresAt: string;
  readonly planHash: string;
  readonly reasonCodes: readonly string[];
  readonly schemaVersion: typeof DAEMON_REPAIR_PLAN_SCHEMA;
  readonly steps: readonly ResidentDaemonRepairStep[];
  readonly target: ResidentDaemonRepairTarget;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedProcesses(
  processes: readonly ResidentMuseProcess[]
): readonly ResidentMuseProcess[] {
  return [...processes].sort((left, right) =>
    left.pid - right.pid
    || left.ppid - right.ppid
    || left.role.localeCompare(right.role)
    || left.startedAt.localeCompare(right.startedAt)
    || left.cwd.localeCompare(right.cwd)
    || left.executableRealpath.localeCompare(right.executableRealpath)
    || Number(left.matchesLaunchdPid) - Number(right.matchesLaunchdPid)
  );
}

function repairPlatform(status: DaemonAutostartStatus): RepairPlatform {
  return status.kind === "darwin" || status.kind === "win32"
    ? status.kind
    : "unmanaged";
}

function repairTarget(
  env: NodeJS.ProcessEnv,
  snapshot: ResidentDaemonRepairSnapshot
): ResidentDaemonRepairTarget {
  const platform = repairPlatform(snapshot.autostart);
  const artifact = snapshot.autostart.kind === "darwin"
    ? snapshot.autostart.plistFile
    : snapshot.autostart.kind === "win32"
      ? snapshot.autostart.taskName
      : resolveLaunchAgentFile(env);
  const label = snapshot.autostart.kind === "win32"
    ? snapshot.autostart.taskName
    : snapshot.autostart.kind === "darwin"
      ? LAUNCH_AGENT_LABEL
      : SCHTASKS_TASK_NAME;
  return {
    artifact,
    cliEntry: snapshot.desired.state === "valid" ? snapshot.desired.cliEntry : null,
    label,
    platform,
    processIds: sortedProcesses(snapshot.processes).map((process) => process.pid),
    runtimeExecutable: snapshot.desired.state === "valid"
      ? snapshot.desired.runtimeExecutable
      : null
  };
}

function canonicalSnapshot(snapshot: ResidentDaemonRepairSnapshot): string {
  const value = {
    autostart: snapshot.autostart,
    desired: snapshot.desired,
    health: {
      reasonCodes: [...new Set(snapshot.health.reasonCodes)].sort(),
      status: snapshot.health.status
    },
    processes: sortedProcesses(snapshot.processes).map((process) => ({
      cwd: process.cwd,
      executableRealpath: process.executableRealpath,
      matchesLaunchdPid: process.matchesLaunchdPid,
      pid: process.pid,
      ppid: process.ppid,
      role: process.role,
      startedAt: process.startedAt
    }))
  };
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)])
    );
  };
  return JSON.stringify(sortKeys(value));
}

export function residentDaemonRepairSnapshotHash(
  snapshot: ResidentDaemonRepairSnapshot
): string {
  return sha256(canonicalSnapshot(snapshot));
}

function targetMatchesSnapshot(
  target: ResidentDaemonRepairTarget,
  snapshot: ResidentDaemonRepairSnapshot
): boolean {
  const expectedPlatform = repairPlatform(snapshot.autostart);
  const expectedArtifact = snapshot.autostart.kind === "darwin"
    ? snapshot.autostart.plistFile
    : snapshot.autostart.kind === "win32"
      ? snapshot.autostart.taskName
      : target.artifact;
  const expectedLabel = snapshot.autostart.kind === "win32"
    ? snapshot.autostart.taskName
    : snapshot.autostart.kind === "darwin"
      ? LAUNCH_AGENT_LABEL
      : SCHTASKS_TASK_NAME;
  const expectedProcessIds = sortedProcesses(snapshot.processes).map((process) => process.pid);
  return target.platform === expectedPlatform
    && target.artifact === expectedArtifact
    && target.label === expectedLabel
    && JSON.stringify(target.processIds) === JSON.stringify(expectedProcessIds)
    && target.cliEntry === (
      snapshot.desired.state === "valid" ? snapshot.desired.cliEntry : null
    )
    && target.runtimeExecutable === (
      snapshot.desired.state === "valid" ? snapshot.desired.runtimeExecutable : null
    );
}

function planBody(plan: Omit<ResidentDaemonRepairPlan, "planHash">): string {
  return JSON.stringify(plan);
}

function repairStartsFromAbsence(snapshot: ResidentDaemonRepairSnapshot): boolean {
  if (snapshot.processes.length > 0) return false;
  const sharedAbsenceConfirmed = snapshot.health.status === "failed"
    && snapshot.health.reasonCodes.includes("daemon-artifact-missing")
    && snapshot.health.reasonCodes.includes("daemon-not-registered");
  if (!sharedAbsenceConfirmed) return false;
  return snapshot.autostart.kind === "darwin"
    ? snapshot.autostart.artifact.state === "missing"
      && snapshot.autostart.runtime.state === "not-registered"
    : snapshot.autostart.kind === "win32"
      ? snapshot.autostart.artifact.state === "missing"
        && snapshot.autostart.registration === "not-registered"
      : false;
}

export function buildResidentDaemonRepairPlan(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly now: Date;
  readonly snapshot: ResidentDaemonRepairSnapshot;
}): ResidentDaemonRepairPlan {
  const target = repairTarget(input.env, input.snapshot);
  const healthy = input.snapshot.health.status === "healthy";
  const missingArtifact = repairStartsFromAbsence(input.snapshot);
  const unsafeProcessTargets = input.snapshot.processes.some((process) =>
    process.role !== "resident" || !process.matchesLaunchdPid
  ) || input.snapshot.processes.filter((process) => process.role === "resident").length > 1;
  const disposition: RepairDisposition = target.platform === "unmanaged"
    || input.snapshot.desired.state === "invalid"
    || unsafeProcessTargets
    || (!healthy && !missingArtifact)
    ? "blocked"
    : healthy
      ? "no-op"
      : "repairable";
  const reasonCodes = target.platform === "unmanaged"
    ? ["daemon-repair-platform-unmanaged"]
    : input.snapshot.desired.state === "invalid"
      ? [input.snapshot.desired.reasonCode]
    : unsafeProcessTargets
      ? [...new Set([
          ...input.snapshot.health.reasonCodes,
          "daemon-repair-process-targets-require-manual-stop"
        ])]
      : !healthy && !missingArtifact
        ? [...new Set([
            ...input.snapshot.health.reasonCodes,
            "daemon-repair-requires-versioned-backup"
          ])]
    : healthy
      ? []
      : [...input.snapshot.health.reasonCodes];
  const canonicalReasonCodes = [...new Set(reasonCodes)].sort();
  const steps: readonly ResidentDaemonRepairStep[] = disposition === "repairable"
    ? [{
        effect: "service-manager-and-artifact",
        id: "reinstall-autostart",
        reversible: true,
        rollback: "muse daemon --uninstall",
        target
      }]
    : [];
  const createdAt = input.now.toISOString();
  const body: Omit<ResidentDaemonRepairPlan, "planHash"> = {
    applyCommand: "muse daemon --apply-repair-plan <plan-file>",
    beforeHash: residentDaemonRepairSnapshotHash(input.snapshot),
    createdAt,
    disposition,
    expiresAt: new Date(input.now.getTime() + DAEMON_REPAIR_PLAN_MAX_AGE_MS).toISOString(),
    reasonCodes: canonicalReasonCodes,
    schemaVersion: DAEMON_REPAIR_PLAN_SCHEMA,
    steps,
    target
  };
  return { ...body, planHash: sha256(planBody(body)) };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validInstant(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function parseTarget(value: unknown): ResidentDaemonRepairTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, [
    "artifact",
    "cliEntry",
    "label",
    "platform",
    "processIds",
    "runtimeExecutable"
  ])) return undefined;
  if (
    typeof row.artifact !== "string"
    || row.artifact.length === 0
    || (row.cliEntry !== null && (typeof row.cliEntry !== "string" || row.cliEntry.length === 0))
    || typeof row.label !== "string"
    || row.label.length === 0
    || (row.platform !== "darwin" && row.platform !== "win32" && row.platform !== "unmanaged")
    || !Array.isArray(row.processIds)
    || row.processIds.some((pid) => !Number.isSafeInteger(pid) || (pid as number) <= 0)
    || (
      row.runtimeExecutable !== null
      && (typeof row.runtimeExecutable !== "string" || row.runtimeExecutable.length === 0)
    )
    || ((row.cliEntry === null) !== (row.runtimeExecutable === null))
  ) return undefined;
  return row as unknown as ResidentDaemonRepairTarget;
}

export function parseResidentDaemonRepairPlan(
  text: string,
  now: Date
): ResidentDaemonRepairPlan | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (!exactKeys(row, [
      "applyCommand",
      "beforeHash",
      "createdAt",
      "disposition",
      "expiresAt",
      "planHash",
      "reasonCodes",
      "schemaVersion",
      "steps",
      "target"
    ])) return undefined;
    const target = parseTarget(row.target);
    if (
      row.schemaVersion !== DAEMON_REPAIR_PLAN_SCHEMA
      || row.applyCommand !== "muse daemon --apply-repair-plan <plan-file>"
      || typeof row.beforeHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(row.beforeHash)
      || typeof row.planHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(row.planHash)
      || !validInstant(row.createdAt)
      || !validInstant(row.expiresAt)
      || Date.parse(row.createdAt) > now.getTime()
      || Date.parse(row.expiresAt) <= now.getTime()
      || Date.parse(row.expiresAt) - Date.parse(row.createdAt) !== DAEMON_REPAIR_PLAN_MAX_AGE_MS
      || (row.disposition !== "no-op" && row.disposition !== "repairable" && row.disposition !== "blocked")
      || !Array.isArray(row.reasonCodes)
      || row.reasonCodes.some((reason) => typeof reason !== "string" || reason.length === 0)
      || JSON.stringify(row.reasonCodes) !== JSON.stringify(
        [...new Set(row.reasonCodes as string[])].sort()
      )
      || !Array.isArray(row.steps)
      || !target
    ) return undefined;
    const steps = row.steps.map((step): ResidentDaemonRepairStep | undefined => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return undefined;
      const value = step as Record<string, unknown>;
      const stepTarget = parseTarget(value.target);
      if (
        !exactKeys(value, ["effect", "id", "reversible", "rollback", "target"])
        || value.id !== "reinstall-autostart"
        || value.effect !== "service-manager-and-artifact"
        || value.reversible !== true
        || value.rollback !== "muse daemon --uninstall"
        || !stepTarget
        || JSON.stringify(stepTarget) !== JSON.stringify(target)
      ) return undefined;
      return value as unknown as ResidentDaemonRepairStep;
    });
    if (steps.some((step) => step === undefined)) return undefined;
    if ((row.disposition === "repairable") !== (steps.length === 1)) return undefined;
    if (row.disposition !== "repairable" && steps.length !== 0) return undefined;
    if (row.disposition === "no-op" && row.reasonCodes.length !== 0) return undefined;
    if (row.disposition !== "no-op" && row.reasonCodes.length === 0) return undefined;
    const body = {
      applyCommand: row.applyCommand,
      beforeHash: row.beforeHash,
      createdAt: row.createdAt,
      disposition: row.disposition,
      expiresAt: row.expiresAt,
      reasonCodes: row.reasonCodes,
      schemaVersion: row.schemaVersion,
      steps,
      target
    } as Omit<ResidentDaemonRepairPlan, "planHash">;
    if (sha256(planBody(body)) !== row.planHash) return undefined;
    return { ...body, planHash: row.planHash };
  } catch {
    return undefined;
  }
}

export async function applyResidentDaemonRepairPlan(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly execute: (step: ResidentDaemonRepairStep) => Promise<boolean>;
  readonly now: Date;
  readonly plan: ResidentDaemonRepairPlan;
  readonly snapshot: ResidentDaemonRepairSnapshot;
}): Promise<"applied" | "no-op" | "blocked" | "stale" | "failed"> {
  const expectedPlan = buildResidentDaemonRepairPlan({
    env: input.env,
    now: new Date(input.plan.createdAt),
    snapshot: input.snapshot
  });
  if (
    input.now.getTime() < Date.parse(input.plan.createdAt)
    || input.now.getTime() >= Date.parse(input.plan.expiresAt)
    || residentDaemonRepairSnapshotHash(input.snapshot) !== input.plan.beforeHash
    || !targetMatchesSnapshot(input.plan.target, input.snapshot)
    || JSON.stringify(input.plan) !== JSON.stringify(expectedPlan)
  ) return "stale";
  if (input.plan.disposition === "no-op") return "no-op";
  if (input.plan.disposition === "blocked") return "blocked";
  for (const step of input.plan.steps) {
    if (!await input.execute(step)) return "failed";
  }
  return "applied";
}
