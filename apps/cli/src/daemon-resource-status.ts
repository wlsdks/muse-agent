import { describeDaemonResourceAdmission, type DaemonResourceAdmission, type DaemonResourcePolicy, type DaemonResourceSnapshot } from "./daemon-resource-admission.js";
import { describeDaemonResourceAdmissionReceipt, type DaemonResourceReceipt } from "./daemon-resource-receipt.js";

export function describeDaemonResourceStatus(input: {
  readonly admission: DaemonResourceAdmission;
  readonly now?: Date;
  readonly policy: DaemonResourcePolicy;
  readonly receipt: DaemonResourceReceipt | undefined;
  readonly snapshot: DaemonResourceSnapshot;
  readonly source: "LaunchAgent" | "shell/default";
}): string {
  return `${describeDaemonResourceAdmission(input.policy, input.snapshot, input.admission, input.source)}; ${describeDaemonResourceAdmissionReceipt(input.receipt, input.now)}`;
}
