import {
  DELIVERY_SAFETY_REASON,
  createUnverifiedDeliverySafetyResult,
  isDeliverySafetyResult
} from "@muse/runtime-state";
import { describe, expect, it } from "vitest";

import { resolveDeliverySafety } from "./delivery-safety-resolver.js";

describe("resolveDeliverySafety", () => {
  it.each([
    ["absent", undefined],
    ["throwing", async () => {
      throw new Error("PRIVATE /owner/path provider=secret payload=secret");
    }],
    ["invalid", async () => ({ rawProvider: "secret" }) as never]
  ] as const)("returns the exact canonical unverified result for an %s supplier", async (_name, supplier) => {
    const result = await resolveDeliverySafety(supplier);

    expect(result).toEqual(createUnverifiedDeliverySafetyResult());
    expect(result.reasonCodes).toContain(DELIVERY_SAFETY_REASON.deliveryBrakeUnverified);
    expect(result.reasonCodes).not.toContain(DELIVERY_SAFETY_REASON.deliveryBrakeEngaged);
    expect(Object.keys(result)).toEqual(["evidence", "reasonCodes", "schemaVersion", "status"]);
    expect(isDeliverySafetyResult(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|\/owner\/path|provider=secret|payload=secret/iu);
  });
});
