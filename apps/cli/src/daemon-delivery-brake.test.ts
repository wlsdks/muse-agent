import { describe, expect, it } from "vitest";

import {
  DAEMON_DELIVERY_BRAKE_RECEIPT_PREFIX,
  formatDaemonDeliveryBrakeAuditReceipt,
  resolveDaemonDeliveryBrake
} from "@muse/shared";

describe("daemon delivery brake", () => {
  it("preserves explicit/unset semantics and fails closed on malformed values", () => {
    expect(resolveDaemonDeliveryBrake({})).toEqual({
      engaged: false,
      mode: "delivery-enabled",
      reason: null,
      settingState: "unset"
    });
    expect(resolveDaemonDeliveryBrake({ MUSE_DAEMON_DELIVERY_ENABLED: "true" })).toMatchObject({
      engaged: false,
      mode: "delivery-enabled",
      settingState: "enabled"
    });
    expect(resolveDaemonDeliveryBrake({ MUSE_DAEMON_DELIVERY_ENABLED: "false" })).toEqual({
      engaged: true,
      mode: "heartbeat-only",
      reason: "delivery-disabled",
      settingState: "braked"
    });
    for (const value of ["", " ", "sometimes", "2"]) {
      expect(resolveDaemonDeliveryBrake({ MUSE_DAEMON_DELIVERY_ENABLED: value }), value).toEqual({
        engaged: true,
        mode: "heartbeat-only",
        reason: "delivery-setting-invalid",
        settingState: "invalid"
      });
    }
  });

  it("emits a channel-independent bounded audit receipt", () => {
    const line = formatDaemonDeliveryBrakeAuditReceipt(
      resolveDaemonDeliveryBrake({ MUSE_DAEMON_DELIVERY_ENABLED: "false" })
    );
    expect(line.startsWith(DAEMON_DELIVERY_BRAKE_RECEIPT_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(DAEMON_DELIVERY_BRAKE_RECEIPT_PREFIX.length))).toEqual({
      engaged: true,
      mode: "heartbeat-only",
      outboundAllowed: false,
      reason: "delivery-disabled",
      settingState: "braked",
      version: 1
    });
  });
});
