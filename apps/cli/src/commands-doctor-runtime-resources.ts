import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";

import type { MuseEnvironment } from "@muse/autoconfigure";

import { parseLaunchAgentEnvironmentVariables, type DaemonAutostartStatus } from "./commands-daemon.js";
import { formatBytes, type LocalCheck } from "./commands-doctor-checks.js";
import { assessDaemonResourceAdmission, resolveDaemonResourcePolicy, type DaemonResourceSnapshot } from "./daemon-resource-admission.js";
import { readDaemonResourceAdmissionReceipt, resolveDaemonResourceReceiptFile } from "./daemon-resource-receipt.js";
import { describeDaemonResourceStatus, type ResidentDaemonProcessSnapshot } from "./daemon-resource-status.js";
import { describeDaemonWorkloadProfile, readDaemonWorkloadProfile, resolveDaemonWorkloadProfileFile } from "./daemon-workload-profile.js";
import { probeOllamaLoadedModels } from "./ollama-probe.js";

type ResidentProcessProbe = (
  executable: string,
  args: readonly string[],
  options: { readonly encoding: "utf8"; readonly maxBuffer: number; readonly timeout: number }
) => string;

/** Read only the verified LaunchAgent PID; never infer a daemon from process names. */
export function readResidentDaemonProcessSnapshot(
  daemonAutostart: DaemonAutostartStatus,
  probe: ResidentProcessProbe = (executable, args, options) => execFileSync(executable, args, options)
): ResidentDaemonProcessSnapshot | undefined {
  if (daemonAutostart.kind !== "darwin" || daemonAutostart.runtime.state !== "running") return undefined;
  try {
    const output = probe(
      "/bin/ps",
      ["-p", daemonAutostart.runtime.pid.toString(), "-o", "rss=,%cpu="],
      { encoding: "utf8", maxBuffer: 16 * 1024, timeout: 1_000 }
    ).trim();
    const match = /^(\d+)\s+([0-9]+(?:\.[0-9]+)?)$/u.exec(output);
    if (!match) return undefined;
    const rssKiB = Number(match[1]);
    const cpuPercent = Number(match[2]);
    if (!Number.isSafeInteger(rssKiB) || rssKiB <= 0 || !Number.isFinite(cpuPercent) || cpuPercent < 0) return undefined;
    return { cpuPercent, residentMemoryBytes: rssKiB * 1024 };
  } catch {
    return undefined;
  }
}

/** Resolve the resource policy the resident process receives after reboot. */
async function resolveDaemonResourceEnvironment(
  env: MuseEnvironment,
  daemonAutostart: DaemonAutostartStatus
): Promise<{ readonly env: NodeJS.ProcessEnv; readonly source: "LaunchAgent" | "shell/default" }> {
  if (daemonAutostart.kind !== "darwin" || daemonAutostart.artifact.state !== "valid") {
    return { env, source: "shell/default" };
  }
  try {
    const variables = parseLaunchAgentEnvironmentVariables(await fs.readFile(daemonAutostart.plistFile, "utf8"));
    if (variables === undefined) return { env, source: "shell/default" };
    const residentEnv = Object.create(env) as NodeJS.ProcessEnv;
    for (const key of ["MUSE_DAEMON_BACKGROUND_MODE", "MUSE_DAEMON_RESOURCE_GUARD", "MUSE_DAEMON_MIN_IDLE_SECONDS", "MUSE_DAEMON_MIN_FREE_MEMORY_MB", "MUSE_DAEMON_MAX_LOAD_PER_CORE", "MUSE_DAEMON_RESOURCE_RECEIPT_FILE", "MUSE_HOME"] as const) {
      // An absent resident key means the daemon uses its code default; shadow
      // shell overrides so this diagnostic cannot report a policy launchd lacks.
      Object.defineProperty(residentEnv, key, { configurable: true, enumerable: true, value: variables[key], writable: false });
    }
    return { env: residentEnv, source: "LaunchAgent" };
  } catch {
    return { env, source: "shell/default" };
  }
}

export async function buildDaemonResourceDoctorCheck(input: {
  readonly daemonAutostart: DaemonAutostartStatus;
  readonly env: MuseEnvironment;
  readonly residentProcess?: ResidentDaemonProcessSnapshot;
  readonly snapshot: DaemonResourceSnapshot;
}): Promise<LocalCheck> {
  const resourceEnvironment = await resolveDaemonResourceEnvironment(input.env, input.daemonAutostart);
  const policy = resolveDaemonResourcePolicy(resourceEnvironment.env);
  const admission = assessDaemonResourceAdmission(resourceEnvironment.env, input.snapshot);
  const receipt = await readDaemonResourceAdmissionReceipt(resolveDaemonResourceReceiptFile(resourceEnvironment.env));
  const profile = await readDaemonWorkloadProfile(resolveDaemonWorkloadProfileFile(resourceEnvironment.env));
  return {
    detail: `${describeDaemonResourceStatus({ admission, policy, receipt, residentProcess: input.residentProcess, snapshot: input.snapshot, source: resourceEnvironment.source })}; ${describeDaemonWorkloadProfile(profile)}`,
    name: "daemon resources",
    status: admission.status === "defer" ? "warn" : "ok"
  };
}

/** Explicit loopback-only GET /api/ps diagnostic; never loads or generates. */
export async function buildLocalModelMemoryDoctorCheck(input: {
  readonly baseUrl: string;
  readonly fetchImpl: typeof globalThis.fetch;
}): Promise<LocalCheck> {
  const result = await probeOllamaLoadedModels(input.baseUrl, { fetchImpl: input.fetchImpl });
  if (!result.reachable) {
    return {
      detail: result.reason === "non-local-url"
        ? "held: configured Ollama URL is not loopback; no request sent"
        : `local Ollama unavailable${result.status === undefined ? "" : ` (HTTP ${result.status.toString()})`}`,
      name: "local model memory",
      status: "warn"
    };
  }
  if (result.models.length === 0) return { detail: "no models currently loaded", name: "local model memory", status: "ok" };
  const totalBytes = result.models.reduce((sum, model) => sum + (model.size ?? 0), 0);
  const totalVramBytes = result.models.reduce((sum, model) => sum + (model.sizeVram ?? 0), 0);
  const rows = result.models.map((model) => `${model.name} allocated ${formatBytes(model.size ?? 0)}, GPU/unified ${formatBytes(model.sizeVram ?? 0)}${model.contextLength === undefined ? "" : `, context ${model.contextLength.toLocaleString("en-US")}`}`);
  return {
    detail: `${result.models.length.toString()} loaded; allocated ${formatBytes(totalBytes)}, GPU/unified ${formatBytes(totalVramBytes)}; ${rows.join("; ")}`,
    name: "local model memory",
    status: "ok"
  };
}
