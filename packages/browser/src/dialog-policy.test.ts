import { describe, expect, it, vi } from "vitest";

import {
  decideDialogDisposition,
  planDialogResponse,
  settleDialog,
  type DialogPlan
} from "./dialog-policy.js";

describe("decideDialogDisposition", () => {
  it("accepts alert", () => {
    expect(decideDialogDisposition("alert")).toBe("accept");
  });

  it("accepts beforeunload", () => {
    expect(decideDialogDisposition("beforeunload")).toBe("accept");
  });

  it("dismisses confirm — fail-close, not the user's approved intent", () => {
    expect(decideDialogDisposition("confirm")).toBe("dismiss");
  });

  it("dismisses prompt — fail-close, not the user's approved intent", () => {
    expect(decideDialogDisposition("prompt")).toBe("dismiss");
  });

  it("dismisses an unknown/empty type", () => {
    expect(decideDialogDisposition("")).toBe("dismiss");
    expect(decideDialogDisposition("something-new")).toBe("dismiss");
  });
});

describe("planDialogResponse", () => {
  it("confirm: dismiss, no acceptValue, record has no response", () => {
    const plan = planDialogResponse("confirm", "Delete this?", "");
    expect(plan.disposition).toBe("dismiss");
    expect(plan.acceptValue).toBeUndefined();
    expect(plan.record).toEqual({ type: "confirm", message: "Delete this?" });
  });

  it("prompt: dismiss, no acceptValue — a page prompt is NOT auto-submitted", () => {
    const plan = planDialogResponse("prompt", "Enter coupon code", "SAVE10");
    expect(plan.disposition).toBe("dismiss");
    expect(plan.acceptValue).toBeUndefined();
    expect(plan.record).toEqual({ type: "prompt", message: "Enter coupon code" });
  });

  it("alert: accept, no response in the record", () => {
    const plan = planDialogResponse("alert", "Saved!", "");
    expect(plan.disposition).toBe("accept");
    expect(plan.record).toEqual({ type: "alert", message: "Saved!" });
  });

  it("beforeunload: accept", () => {
    const plan = planDialogResponse("beforeunload", "", "");
    expect(plan.disposition).toBe("accept");
  });
});

describe("settleDialog — the actual dialog call the disposition maps to", () => {
  function fakeDialog(): { accept: ReturnType<typeof vi.fn<(value?: string) => Promise<void>>>; dismiss: ReturnType<typeof vi.fn<() => Promise<void>>> } {
    return {
      accept: vi.fn<(value?: string) => Promise<void>>().mockResolvedValue(undefined),
      dismiss: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    };
  }

  it("confirm plan calls dismiss, never accept", async () => {
    const dialog = fakeDialog();
    const plan = planDialogResponse("confirm", "Delete this?", "");
    await settleDialog(dialog, plan);
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(dialog.accept).not.toHaveBeenCalled();
  });

  it("alert plan calls accept, never dismiss", async () => {
    const dialog = fakeDialog();
    const plan = planDialogResponse("alert", "Saved!", "");
    await settleDialog(dialog, plan);
    expect(dialog.accept).toHaveBeenCalledTimes(1);
    expect(dialog.accept).toHaveBeenCalledWith(undefined);
    expect(dialog.dismiss).not.toHaveBeenCalled();
  });

  it("a hypothetical accept-prompt plan calls accept with the plan's acceptValue", async () => {
    const dialog = fakeDialog();
    const plan: DialogPlan = {
      disposition: "accept",
      acceptValue: "SAVE10",
      record: { type: "prompt", message: "Enter coupon code", response: "SAVE10" }
    };
    await settleDialog(dialog, plan);
    expect(dialog.accept).toHaveBeenCalledWith("SAVE10");
    expect(dialog.dismiss).not.toHaveBeenCalled();
  });
});
