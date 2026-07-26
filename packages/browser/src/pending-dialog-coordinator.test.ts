import { describe, expect, it, vi } from "vitest";

import {
  PendingDialogCoordinator,
  type PendingDialogClaim,
  type PendingDialogIdentity
} from "./pending-dialog-coordinator.js";

function coordinator(ids: readonly string[] = ["dialog", "claim", "next-dialog"]): PendingDialogCoordinator {
  let offset = 0;
  return new PendingDialogCoordinator({
    idFactory: () => ids[offset++] ?? `id-${offset.toString()}`,
    sessionIncarnation: "session-1"
  });
}

function openConfirm(subject = coordinator()): {
  readonly coordinator: PendingDialogCoordinator;
  readonly identity: PendingDialogIdentity;
} {
  const opened = subject.open({
    message: "Apply the approved action?",
    pageTargetId: "target-1",
    pageUrl: "https://example.test/form",
    type: "confirm"
  });
  if (!opened.ok) throw new Error(opened.reason);
  return { coordinator: subject, identity: opened.identity };
}

function claimConfirm(
  subject: PendingDialogCoordinator,
  identity: PendingDialogIdentity,
  claimantId = "owner-request-1"
): PendingDialogClaim {
  const claimed = subject.claim({
    claimantId,
    decision: { kind: "accept" },
    identity
  });
  if (!claimed.ok) throw new Error(claimed.reason);
  return claimed.claim;
}

describe("PendingDialogCoordinator", () => {
  it("creates an opaque exact identity and allows only one active dialog", () => {
    const subject = coordinator();
    const opened = subject.open({
      message: "Enter the exact code",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/coupon",
      promptDefaultValue: "SAVE10",
      type: "prompt"
    });

    expect(opened).toEqual({
      identity: {
        dialogId: "dlg_dialog",
        generation: 1,
        message: "Enter the exact code",
        pageTargetId: "target-1",
        pageUrl: "https://example.test/coupon",
        promptDefaultValue: "SAVE10",
        sessionIncarnation: "session-1",
        type: "prompt"
      },
      ok: true
    });
    expect(subject.open({
      message: "Second",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/coupon",
      type: "confirm"
    })).toEqual({ ok: false, reason: "dialog-already-active" });
  });

  it("fails closed when identity allocation reenters open", () => {
    let nested: ReturnType<PendingDialogCoordinator["open"]> | undefined;
    const subject = new PendingDialogCoordinator({
      idFactory: () => {
        nested = subject.open({
          message: "Nested dialog",
          pageTargetId: "target-nested",
          pageUrl: "https://example.test/nested",
          type: "confirm"
        });
        return "outer-dialog";
      },
      sessionIncarnation: "session-1"
    });

    const outer = subject.open({
      message: "Outer dialog",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/form",
      type: "confirm"
    });
    expect(outer).toMatchObject({ identity: { dialogId: "dlg_outer-dialog" }, ok: true });
    expect(nested).toEqual({ ok: false, reason: "coordinator-busy" });
    expect(subject.open({
      message: "Third dialog",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/form",
      type: "confirm"
    })).toEqual({ ok: false, reason: "dialog-already-active" });
  });

  it("releases an opening reservation when identity allocation throws", () => {
    let allocation = 0;
    const subject = new PendingDialogCoordinator({
      idFactory: () => {
        allocation += 1;
        if (allocation === 1) throw new Error("entropy unavailable");
        return "recovered-dialog";
      },
      sessionIncarnation: "session-1"
    });

    expect(() => openConfirm(subject)).toThrow("entropy unavailable");
    expect(openConfirm(subject).identity).toMatchObject({
      dialogId: "dlg_recovered-dialog",
      generation: 1
    });
  });

  it("binds the exact prompt response and rejects invalid decision shapes without claiming", () => {
    const subject = coordinator();
    const opened = subject.open({
      message: "Enter coupon",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/coupon",
      promptDefaultValue: "SAVE10",
      type: "prompt"
    });
    if (!opened.ok) throw new Error(opened.reason);

    expect(subject.claim({
      claimantId: "owner-request",
      decision: { kind: "accept" },
      identity: opened.identity
    })).toEqual({ ok: false, reason: "invalid-decision" });
    const claimed = subject.claim({
      claimantId: "owner-request",
      decision: { kind: "accept", promptResponse: "OWNER-CODE" },
      identity: opened.identity
    });
    expect(claimed).toMatchObject({
      claim: {
        claimantId: "owner-request",
        claimToken: "clm_claim",
        decision: { kind: "accept", promptResponse: "OWNER-CODE" }
      },
      ok: true
    });
  });

  it("rejects runtime-forged decision kinds and extra response fields", () => {
    const { coordinator: subject, identity } = openConfirm();

    expect(subject.claim({
      claimantId: "owner-request",
      decision: { kind: "approve" } as unknown as { readonly kind: "accept" },
      identity
    })).toEqual({ ok: false, reason: "invalid-decision" });
    expect(subject.claim({
      claimantId: "owner-request",
      decision: {
        kind: "dismiss",
        promptResponse: "forged"
      } as unknown as { readonly kind: "dismiss" },
      identity
    })).toEqual({ ok: false, reason: "invalid-decision" });
    expect(subject.inspect(identity)).toMatchObject({ status: "pending" });
  });

  it("grants exactly one synchronous claimant", () => {
    const { coordinator: subject, identity } = openConfirm();
    const first = subject.claim({
      claimantId: "owner-a",
      decision: { kind: "accept" },
      identity
    });
    const second = subject.claim({
      claimantId: "owner-b",
      decision: { kind: "dismiss" },
      identity
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "not-pending" });
  });

  it("fails closed when claim-token allocation reenters state mutation", () => {
    const state: { identity?: PendingDialogIdentity } = {};
    let nestedClaim: ReturnType<PendingDialogCoordinator["claim"]> | undefined;
    let nestedAbandon: ReturnType<PendingDialogCoordinator["abandon"]> | undefined;
    let allocation = 0;
    const subject = new PendingDialogCoordinator({
      idFactory: () => {
        allocation += 1;
        if (allocation === 1) return "dialog";
        if (!state.identity) throw new Error("missing dialog identity");
        nestedClaim = subject.claim({
          claimantId: "nested-owner",
          decision: { kind: "dismiss" },
          identity: state.identity
        });
        nestedAbandon = subject.abandon(state.identity, "nested-abandon");
        return "outer-claim";
      },
      sessionIncarnation: "session-1"
    });
    state.identity = openConfirm(subject).identity;

    const outer = subject.claim({
      claimantId: "outer-owner",
      decision: { kind: "accept" },
      identity: state.identity
    });
    expect(outer).toMatchObject({
      claim: { claimantId: "outer-owner", claimToken: "clm_outer-claim" },
      ok: true
    });
    expect(nestedClaim).toEqual({ ok: false, reason: "coordinator-busy" });
    expect(nestedAbandon).toEqual({ ok: false, reason: "coordinator-busy" });
    expect(subject.inspect(state.identity)).toMatchObject({
      claimantId: "outer-owner",
      decision: { kind: "accept" },
      status: "claimed"
    });
  });

  it("releases a claim reservation without mutation when token allocation throws", () => {
    let allocation = 0;
    const subject = new PendingDialogCoordinator({
      idFactory: () => {
        allocation += 1;
        if (allocation === 1) return "dialog";
        if (allocation === 2) throw new Error("entropy unavailable");
        return "recovered-claim";
      },
      sessionIncarnation: "session-1"
    });
    const { identity } = openConfirm(subject);

    expect(() => claimConfirm(subject, identity)).toThrow("entropy unavailable");
    expect(subject.inspect(identity)).toMatchObject({ status: "pending" });
    expect(claimConfirm(subject, identity)).toMatchObject({
      claimToken: "clm_recovered-claim"
    });
  });

  it("acknowledges only after the live executor resolves", async () => {
    const { coordinator: subject, identity } = openConfirm();
    const claim = claimConfirm(subject, identity);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const executor = vi.fn(async () => blocked);

    const execution = subject.execute(claim, executor);
    expect(subject.inspect(identity)).toMatchObject({ status: "claimed" });
    release();

    await expect(execution).resolves.toMatchObject({
      ok: true,
      receipt: {
        claimantId: "owner-request-1",
        decision: { kind: "accept" },
        schemaVersion: "muse.browser-dialog-decision-receipt/v1",
        status: "acknowledged"
      }
    });
    expect(subject.inspect(identity)).toMatchObject({ status: "acknowledged" });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("makes executor rejection terminal and never rearms authority", async () => {
    const { coordinator: subject, identity } = openConfirm();
    const claim = claimConfirm(subject, identity);
    const executor = vi.fn(async () => { throw new Error("private driver error"); });

    await expect(subject.execute(claim, executor)).resolves.toEqual({
      ok: false,
      reason: "decision-executor-rejected"
    });
    expect(subject.inspect(identity)).toMatchObject({
      failure: "decision-executor-rejected",
      status: "failed"
    });
    expect(subject.claim({
      claimantId: "owner-retry",
      decision: { kind: "dismiss" },
      identity
    })).toEqual({ ok: false, reason: "terminal" });
    expect(await subject.execute(claim, executor)).toEqual({ ok: false, reason: "terminal" });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rejects wrong identity and claim tokens with zero executor calls and no state change", async () => {
    const { coordinator: subject, identity } = openConfirm();
    const before = subject.inspect(identity);
    const wrongIdentity = { ...identity, pageTargetId: "target-other" };
    expect(subject.claim({
      claimantId: "owner",
      decision: { kind: "accept" },
      identity: wrongIdentity
    })).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(subject.inspect(identity)).toEqual(before);

    const claim = claimConfirm(subject, identity);
    const executor = vi.fn(async () => undefined);
    expect(await subject.execute({ ...claim, claimToken: "clm_wrong" }, executor)).toEqual({
      ok: false,
      reason: "claim-mismatch"
    });
    expect(executor).not.toHaveBeenCalled();
    expect(subject.inspect(identity)).toMatchObject({ status: "claimed" });
  });

  it("allows only one decision execution even when calls overlap", async () => {
    const { coordinator: subject, identity } = openConfirm();
    const claim = claimConfirm(subject, identity);
    let release!: () => void;
    const executor = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));

    const first = subject.execute(claim, executor);
    await expect(subject.execute(claim, executor)).resolves.toEqual({
      ok: false,
      reason: "decision-already-started"
    });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps abandonment terminal when an in-flight executor later %ss",
    async (outcome) => {
      const subject = coordinator(["dialog", "claim", "next-dialog"]);
      const { identity } = openConfirm(subject);
      const claim = claimConfirm(subject, identity);
      let resolveExecution!: () => void;
      let rejectExecution!: (reason: Error) => void;
      const blocked = new Promise<void>((resolve, reject) => {
        resolveExecution = resolve;
        rejectExecution = reject;
      });
      const execution = subject.execute(claim, async () => blocked);

      expect(subject.abandon(identity, "controller-disconnected")).toMatchObject({
        ok: true,
        state: { status: "abandoned" }
      });
      if (outcome === "resolve") resolveExecution();
      else rejectExecution(new Error("driver closed"));

      await expect(execution).resolves.toEqual({ ok: false, reason: "terminal" });
      const finalState = subject.inspect(identity);
      expect(finalState).toMatchObject({
        abandonmentReason: "controller-disconnected",
        status: "abandoned"
      });
      expect(finalState?.failure).toBeUndefined();
      expect(finalState?.receipt).toBeUndefined();
      expect(subject.open({
        message: "New dialog after abandonment",
        pageTargetId: "target-1",
        pageUrl: "https://example.test/form",
        type: "confirm"
      })).toMatchObject({ ok: true });
    }
  );

  it("rejects a reused claim token without mutating or enabling stale-claim replay", async () => {
    const subject = coordinator(["dialog-1", "shared", "dialog-2", "shared"]);
    const first = openConfirm(subject);
    const staleClaim = claimConfirm(subject, first.identity);
    expect(subject.abandon(first.identity, "page-closed").ok).toBe(true);

    const second = subject.open({
      message: "Second dialog",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/form",
      type: "confirm"
    });
    if (!second.ok) throw new Error(second.reason);
    expect(subject.claim({
      claimantId: "owner-request-1",
      decision: { kind: "accept" },
      identity: second.identity
    })).toEqual({ ok: false, reason: "claim-token-collision" });
    expect(subject.inspect(second.identity)).toMatchObject({ status: "pending" });

    const executor = vi.fn(async () => undefined);
    await expect(subject.execute({
      ...staleClaim,
      identity: second.identity
    }, executor)).resolves.toEqual({ ok: false, reason: "not-claimed" });
    expect(executor).not.toHaveBeenCalled();
    expect(subject.inspect(second.identity)).toMatchObject({ status: "pending" });
    expect(subject.claim({
      claimantId: "owner-after-collision",
      decision: { kind: "dismiss" },
      identity: second.identity
    })).toMatchObject({ ok: true });
  });

  it("validates an open before consuming identity or generation authority", () => {
    const subject = coordinator(["dialog"]);

    expect(() => subject.open({
      message: "Unsupported",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/form",
      type: "alert" as unknown as "confirm"
    })).toThrow("unsupported dialog type");
    expect(() => subject.open({
      message: " ",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/form",
      type: "confirm"
    })).toThrow("message must be non-empty exact text");
    expect(openConfirm(subject).identity).toMatchObject({
      dialogId: "dlg_dialog",
      generation: 1
    });
  });

  it.each(["pending", "claimed"] as const)(
    "abandons %s authority terminally without a success receipt",
    async (phase) => {
      const { coordinator: subject, identity } = openConfirm();
      const claim = phase === "claimed" ? claimConfirm(subject, identity) : undefined;
      const abandoned = subject.abandon(identity, "controller-disconnected");

      expect(abandoned).toMatchObject({
        ok: true,
        state: {
          abandonmentReason: "controller-disconnected",
          status: "abandoned"
        }
      });
      if (abandoned.ok) expect(abandoned.state.receipt).toBeUndefined();
      expect(subject.claim({
        claimantId: "owner-after-abandon",
        decision: { kind: "dismiss" },
        identity
      })).toEqual({ ok: false, reason: "terminal" });
      if (claim) {
        const executor = vi.fn(async () => undefined);
        expect(await subject.execute(claim, executor)).toEqual({ ok: false, reason: "terminal" });
        expect(executor).not.toHaveBeenCalled();
      }
    }
  );

  it("increments generation after a terminal dialog and rejects stale identities", () => {
    const subject = coordinator(["dialog-1", "claim-1", "dialog-2"]);
    const first = openConfirm(subject);
    expect(subject.abandon(first.identity, "page-closed").ok).toBe(true);
    const second = subject.open({
      message: "Second dialog",
      pageTargetId: "target-1",
      pageUrl: "https://example.test/form",
      type: "confirm"
    });
    if (!second.ok) throw new Error(second.reason);

    expect(second.identity).toMatchObject({ dialogId: "dlg_claim-1", generation: 2 });
    expect(subject.claim({
      claimantId: "owner",
      decision: { kind: "accept" },
      identity: { ...first.identity, dialogId: second.identity.dialogId }
    })).toEqual({ ok: false, reason: "identity-mismatch" });
  });
});
