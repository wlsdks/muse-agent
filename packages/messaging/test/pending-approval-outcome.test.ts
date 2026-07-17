import { describe, expect, it } from "vitest";

import { classifyPendingApprovalToolOutcome } from "../src/pending-approval-outcome.js";

describe("classifyPendingApprovalToolOutcome", () => {
  it("lets a recognized false marker override a recognized true marker", () => {
    expect(classifyPendingApprovalToolOutcome({ performed: false, sent: true })).toBe("unknown");
  });

  it.each(["ok", "success", "sent", "performed", "completed"] as const)("treats %s:false as unknown", (marker) => {
    expect(classifyPendingApprovalToolOutcome({ sent: true, [marker]: false })).toBe("unknown");
  });

  it("lets a non-empty error override positive markers", () => {
    expect(classifyPendingApprovalToolOutcome({ error: "provider failed", ok: true })).toBe("unknown");
  });

  it.each(["ok", "success", "sent", "performed", "completed"] as const)("accepts %s:true when no failure evidence exists", (marker) => {
    expect(classifyPendingApprovalToolOutcome({ [marker]: true })).toBe("succeeded");
  });

  it("treats unrecognized or absent proof as unknown", () => {
    expect(classifyPendingApprovalToolOutcome({ error: "", value: true })).toBe("unknown");
  });

  it("contains a throwing property getter and returns unknown", () => {
    const result = Object.defineProperty({ sent: true }, "error", {
      get: () => {
        throw new Error("hostile getter");
      }
    });
    expect(() => classifyPendingApprovalToolOutcome(result)).not.toThrow();
    expect(classifyPendingApprovalToolOutcome(result)).toBe("unknown");
  });
});
