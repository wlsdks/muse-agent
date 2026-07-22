import { describeDaemonResourceAdmission, type DaemonResourceAdmission, type DaemonResourcePolicy, type DaemonResourceSnapshot } from "./daemon-resource-admission.js";
import { describeDaemonResourceAdmissionReceipt, type DaemonResourceReceipt } from "./daemon-resource-receipt.js";

export interface ResidentDaemonProcessSnapshot {
  readonly cpuPercent: number;
  readonly residentMemoryBytes: number;
}

export function describeDaemonResourceStatus(input: {
  readonly admission: DaemonResourceAdmission;
  readonly now?: Date;
  readonly policy: DaemonResourcePolicy;
  readonly receipt: DaemonResourceReceipt | undefined;
  readonly residentProcess?: ResidentDaemonProcessSnapshot;
  readonly snapshot: DaemonResourceSnapshot;
  readonly source: "LaunchAgent" | "shell/default";
}): string {
  const liveProcess = input.residentProcess === undefined
    ? "resident daemon process metrics unavailable"
    : `resident daemon RSS ${(input.residentProcess.residentMemoryBytes / (1024 * 1024)).toFixed(0)} MiB, CPU ${input.residentProcess.cpuPercent.toFixed(1)}%`;
  return `${describeDaemonResourceAdmission(input.policy, input.snapshot, input.admission, input.source, "doctor probe")}; ${liveProcess}; ${describeDaemonResourceAdmissionReceipt(input.receipt, input.now)}`;
}
