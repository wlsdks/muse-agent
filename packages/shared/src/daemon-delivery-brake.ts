export const DAEMON_DELIVERY_BRAKE_RECEIPT_VERSION = 1 as const;
export const DAEMON_DELIVERY_BRAKE_RECEIPT_PREFIX = "muse.daemon.delivery-brake ";
const TRUE_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);

export type DaemonDeliverySettingState = "enabled" | "braked" | "unset" | "invalid";
export type DaemonDeliveryBrakeReason = "delivery-disabled" | "delivery-setting-invalid";

export interface DaemonDeliveryBrakeDecision {
  readonly engaged: boolean;
  readonly mode: "delivery-enabled" | "heartbeat-only";
  readonly reason: DaemonDeliveryBrakeReason | null;
  readonly settingState: DaemonDeliverySettingState;
}

export interface DaemonDeliveryBrakeAuditReceipt extends DaemonDeliveryBrakeDecision {
  readonly outboundAllowed: boolean;
  readonly version: typeof DAEMON_DELIVERY_BRAKE_RECEIPT_VERSION;
}

export function resolveDaemonDeliveryBrake(
  env: Readonly<Record<string, string | undefined>>
): DaemonDeliveryBrakeDecision {
  const raw = env.MUSE_DAEMON_DELIVERY_ENABLED;
  const normalized = raw?.trim().toLowerCase();
  const parsed = normalized !== undefined && TRUE_VALUES.has(normalized)
    ? true
    : normalized !== undefined && FALSE_VALUES.has(normalized)
      ? false
      : undefined;
  const settingState: DaemonDeliverySettingState = raw === undefined
    ? "unset"
    : parsed === true
      ? "enabled"
      : parsed === false
        ? "braked"
        : "invalid";
  const engaged = settingState === "braked" || settingState === "invalid";
  return {
    engaged,
    mode: engaged ? "heartbeat-only" : "delivery-enabled",
    reason: settingState === "braked"
      ? "delivery-disabled"
      : settingState === "invalid"
        ? "delivery-setting-invalid"
        : null,
    settingState
  };
}

export function formatDaemonDeliveryBrakeAuditReceipt(
  decision: DaemonDeliveryBrakeDecision
): string {
  const receipt: DaemonDeliveryBrakeAuditReceipt = {
    ...decision,
    outboundAllowed: !decision.engaged,
    version: DAEMON_DELIVERY_BRAKE_RECEIPT_VERSION
  };
  return `${DAEMON_DELIVERY_BRAKE_RECEIPT_PREFIX}${JSON.stringify(receipt)}\n`;
}
