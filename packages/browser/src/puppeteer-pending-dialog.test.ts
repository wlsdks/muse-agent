import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import type { Browser, Dialog, Frame, Page, Target } from "puppeteer-core";

import type { PageSnapshot } from "./controller.js";
import type { PendingDialogIdentity } from "./pending-dialog-coordinator.js";
import { PuppeteerBrowserController } from "./puppeteer-controller.js";

const SNAPSHOT: PageSnapshot = {
  elements: [],
  text: "settled",
  title: "Settled",
  url: "https://example.test/form"
};

interface PendingHarness {
  readonly accept: ReturnType<typeof vi.fn>;
  readonly browser: Browser;
  readonly click: ReturnType<typeof vi.fn>;
  readonly closePage: () => void;
  readonly controller: PuppeteerBrowserController;
  readonly dismiss: ReturnType<typeof vi.fn>;
  readonly page: Page;
  readonly settleDom: ReturnType<typeof vi.fn>;
  readonly snapshot: ReturnType<typeof vi.fn>;
  readonly waitForNetworkIdle: ReturnType<typeof vi.fn>;
}

interface PendingHarnessOptions {
  readonly navigationUrl?: string;
  readonly nestedFrame?: boolean;
  readonly rejectActionAfterDecision?: boolean;
}

function pendingHarness(
  type: "alert" | "beforeunload" | "confirm" | "prompt" | "unknown" = "confirm",
  message = type === "prompt" ? "Enter the exact value" : "Apply the action?",
  closeOnDialog = false,
  options: PendingHarnessOptions = {}
): PendingHarness {
  const pageEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  let pageClosed = false;
  let releaseAction!: () => void;
  let rejectAction!: (cause: Error) => void;
  let currentUrl = "https://example.test/form";
  const action = new Promise<void>((resolve, reject) => {
    releaseAction = resolve;
    rejectAction = reject;
  });
  const accept = vi.fn(async (_response?: string) => {
    if (options.rejectActionAfterDecision) rejectAction(new Error("action cancelled after dialog acknowledgement"));
    else releaseAction();
  });
  const dismiss = vi.fn(async () => {
    if (options.rejectActionAfterDecision) rejectAction(new Error("action cancelled after dialog acknowledgement"));
    else releaseAction();
  });
  const dialog = {
    accept,
    defaultValue: () => type === "prompt" ? "DEFAULT" : "",
    dismiss,
    message: () => message,
    type: () => type
  } as unknown as Dialog;
  const click = vi.fn(() => {
    if (options.navigationUrl) currentUrl = options.navigationUrl;
    pageEvents.emit("dialog", dialog);
    if (closeOnDialog) {
      pageClosed = true;
      pageEvents.emit("close");
    }
    return action;
  });
  const frame = {
    $: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
    locator: vi.fn(() => ({
      setTimeout: vi.fn(() => ({ click }))
    }))
  } as unknown as Frame;
  const outerFrame = {
    $: vi.fn(async () => null)
  } as unknown as Frame;
  const waitForNetworkIdle = vi.fn(async () => undefined);
  const page = Object.assign(pageEvents, {
    frames: () => options.nestedFrame ? [outerFrame, frame] : [frame],
    isClosed: () => pageClosed,
    // Real Puppeteer Page exposes listenerCount but not Node's listeners().
    // Keep this harness faithful so ownership checks cannot depend on the
    // broader node:events API by accident.
    listeners: undefined,
    url: () => currentUrl,
    waitForNetworkIdle
  }) as unknown as Page;
  const browser = Object.assign(browserEvents, {
    connected: true,
    disconnect: vi.fn(async () => {
      browserEvents.emit("disconnected");
      releaseAction();
    }),
    targets: () => [],
    waitForTarget: vi.fn(async () => {
      throw new Error("no new target");
    })
  }) as unknown as Browser;
  const settleDom = vi.fn(async () => undefined);
  const snapshot = vi.fn(async () => options.navigationUrl
    ? { ...SNAPSHOT, title: "After navigation", url: currentUrl }
    : SNAPSHOT);
  const controller = new PuppeteerBrowserController();
  Object.assign(controller, {
    browser,
    page,
    settleDom,
    snapshot
  });
  return {
    accept,
    browser,
    click,
    closePage: () => {
      pageClosed = true;
      pageEvents.emit("close");
      releaseAction();
    },
    controller,
    dismiss,
    page,
    settleDom,
    snapshot,
    waitForNetworkIdle
  };
}

function newTabPendingHarness(
  foreignTargetListener = false,
  foreignPageListener = false
): PendingHarness {
  const sourceEvents = new EventEmitter();
  const targetEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  let targetClosed = false;
  let releaseAction!: () => void;
  const action = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const accept = vi.fn(async () => {
    releaseAction();
  });
  const dismiss = vi.fn(async () => {
    releaseAction();
  });
  const dialog = {
    accept,
    defaultValue: () => "",
    dismiss,
    message: () => "Confirm in new tab",
    type: () => "confirm"
  } as unknown as Dialog;
  const waitForNetworkIdle = vi.fn(async () => undefined);
  const targetPage = Object.assign(targetEvents, {
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      targetClosed = true;
      targetEvents.emit("close");
      targetEvents.removeAllListeners();
    }),
    isClosed: () => targetClosed,
    url: () => "https://popup.example.test/confirm",
    waitForNetworkIdle
  }) as unknown as Page;
  const target = {
    page: vi.fn(async () => targetPage)
  } as unknown as Target;
  if (foreignPageListener) {
    targetEvents.on("dialog", (createdDialog: Dialog) => {
      void createdDialog.accept();
    });
  }
  const click = vi.fn(() => {
    browserEvents.emit("targetcreated", target);
    queueMicrotask(() => targetEvents.emit("dialog", dialog));
    return action;
  });
  const frame = {
    $: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
    locator: vi.fn(() => ({
      setTimeout: vi.fn(() => ({ click }))
    }))
  } as unknown as Frame;
  const sourcePage = Object.assign(sourceEvents, {
    frames: () => [frame],
    isClosed: () => false,
    url: () => "https://example.test/form"
  }) as unknown as Page;
  const browser = Object.assign(browserEvents, {
    connected: true,
    disconnect: vi.fn(async () => browserEvents.emit("disconnected")),
    targets: () => [],
    waitForTarget: vi.fn(async () => target)
  }) as unknown as Browser;
  if (foreignTargetListener) {
    browserEvents.on("targetcreated", (created: Target) => {
      void created.page().then((createdPage) => {
        createdPage?.on("dialog", (createdDialog) => {
          void createdDialog.accept();
        });
      });
    });
  }
  const settleDom = vi.fn(async () => undefined);
  const snapshot = vi.fn(async () => SNAPSHOT);
  const controller = new PuppeteerBrowserController();
  Object.assign(controller, {
    browser,
    page: sourcePage,
    settleDom,
    snapshot
  });
  return {
    accept,
    browser,
    click,
    closePage: () => targetEvents.emit("close"),
    controller,
    dismiss,
    page: sourcePage,
    settleDom,
    snapshot,
    waitForNetworkIdle
  };
}

describe("PuppeteerBrowserController pending dialog path", () => {
  it("returns pending before settle or snapshot and refuses a second continuation", async () => {
    const rig = pendingHarness();

    const result = await rig.controller.clickWithPendingDialog(1);

    expect(result).toMatchObject({
      dialog: {
        message: "Apply the action?",
        pageUrl: "https://example.test/form",
        type: "confirm"
      },
      status: "pending"
    });
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.waitForNetworkIdle).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
    await expect(rig.controller.clickWithPendingDialog(1)).rejects.toThrow(
      "a browser dialog decision is already pending"
    );
    expect(rig.click).toHaveBeenCalledOnce();
  });

  it("preserves an empty confirm message as pending authority", async () => {
    const rig = pendingHarness("confirm", "");

    await expect(rig.controller.clickWithPendingDialog(1)).resolves.toMatchObject({
      dialog: { message: "", type: "confirm" },
      status: "pending"
    });
    expect(rig.dismiss).not.toHaveBeenCalled();
  });

  it("refuses before clicking when dialog-listener ownership is ambiguous", async () => {
    const rig = pendingHarness();
    await expect(rig.controller.hasOpenPage()).resolves.toBe(true);
    rig.page.on("dialog", () => undefined);

    await expect(rig.controller.clickWithPendingDialog(1)).rejects.toThrow(
      "browser dialog handler ownership is unavailable"
    );
    expect(rig.click).not.toHaveBeenCalled();
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
  });

  it("does not return stale pending authority when the page closes during capture", async () => {
    const rig = pendingHarness("confirm", "Closing dialog", true);

    await expect(rig.controller.clickWithPendingDialog(1)).rejects.toThrow(
      "browser dialog was abandoned before authority could be returned"
    );
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
  });

  it("captures a confirm raised by a newly followed tab", async () => {
    const rig = newTabPendingHarness();
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    expect(pending.dialog).toMatchObject({
      message: "Confirm in new tab",
      pageUrl: "https://popup.example.test/confirm",
      type: "confirm"
    });
    expect(rig.dismiss).not.toHaveBeenCalled();
    const decided = await rig.controller.decidePendingDialog({
      claimantId: "owner-request-1",
      decision: { kind: "dismiss" },
      identity: pending.dialog
    });
    expect(decided).toMatchObject({ ok: true });
    expect(rig.dismiss).toHaveBeenCalledOnce();
    expect(rig.waitForNetworkIdle).toHaveBeenCalledTimes(2);
    expect(rig.settleDom).toHaveBeenCalledOnce();
  });

  it("refuses before clicking when browser target ownership is foreign", async () => {
    const rig = newTabPendingHarness(true);

    await expect(rig.controller.clickWithPendingDialog(1)).rejects.toThrow(
      "browser target handler ownership is unavailable"
    );
    expect(rig.click).not.toHaveBeenCalled();
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
  });

  it("closes and fails an action-created page when its dialog ownership is foreign", async () => {
    const rig = newTabPendingHarness(false, true);

    await expect(rig.controller.clickWithPendingDialog(1)).rejects.toThrow(
      "browser dialog handler ownership is unavailable for an action-created page"
    );
    expect(rig.click).toHaveBeenCalledOnce();
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
  });

  it("submits an exact prompt response and settles only after acknowledgement", async () => {
    const rig = pendingHarness("prompt");
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    const decided = await rig.controller.decidePendingDialog({
      claimantId: "owner-request-1",
      decision: { kind: "accept", promptResponse: "OWNER VALUE" },
      identity: pending.dialog
    });

    expect(rig.accept).toHaveBeenCalledExactlyOnceWith("OWNER VALUE");
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.waitForNetworkIdle).toHaveBeenCalledOnce();
    expect(rig.settleDom).toHaveBeenCalledOnce();
    expect(rig.snapshot).toHaveBeenCalledOnce();
    expect(decided).toMatchObject({
      ok: true,
      receipt: {
        decision: { kind: "accept", promptResponse: "OWNER VALUE" },
        status: "acknowledged"
      },
      snapshot: SNAPSHOT
    });
  });

  it("dismisses a pending confirm and resumes the retained continuation once", async () => {
    const rig = pendingHarness();
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    const decided = await rig.controller.decidePendingDialog({
      claimantId: "owner-request-1",
      decision: { kind: "dismiss" },
      identity: pending.dialog
    });

    expect(rig.dismiss).toHaveBeenCalledOnce();
    expect(rig.accept).not.toHaveBeenCalled();
    expect(decided).toMatchObject({ ok: true, snapshot: SNAPSHOT });
    expect(await rig.controller.decidePendingDialog({
      claimantId: "owner-request-2",
      decision: { kind: "accept" },
      identity: pending.dialog
    })).toEqual({ ok: false, reason: "terminal" });
    expect(rig.dismiss).toHaveBeenCalledOnce();
  });

  it("keeps the legacy click path fail-close for page-initiated confirm", async () => {
    const rig = pendingHarness();

    await expect(rig.controller.click(1)).resolves.toEqual(SNAPSHOT);

    expect(rig.dismiss).toHaveBeenCalledOnce();
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.waitForNetworkIdle).toHaveBeenCalledOnce();
    expect(rig.settleDom).toHaveBeenCalledOnce();
    expect(rig.snapshot).toHaveBeenCalledOnce();
  });

  it("keeps informational alert handling on the completed path", async () => {
    const rig = pendingHarness("alert");

    await expect(rig.controller.clickWithPendingDialog(1)).resolves.toEqual({
      snapshot: SNAPSHOT,
      status: "completed"
    });
    expect(rig.accept).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).toHaveBeenCalledOnce();
    expect(rig.snapshot).toHaveBeenCalledOnce();
  });

  it.each([
    { disposition: "accept", type: "beforeunload" },
    { disposition: "dismiss", type: "unknown" }
  ] as const)(
    "keeps $type on the completed path with the fail-close $disposition disposition",
    async ({ disposition, type }) => {
      const rig = pendingHarness(type);

      await expect(rig.controller.clickWithPendingDialog(1)).resolves.toEqual({
        snapshot: SNAPSHOT,
        status: "completed"
      });
      expect(rig.accept).toHaveBeenCalledTimes(disposition === "accept" ? 1 : 0);
      expect(rig.dismiss).toHaveBeenCalledTimes(disposition === "dismiss" ? 1 : 0);
      expect(rig.settleDom).toHaveBeenCalledOnce();
      expect(rig.snapshot).toHaveBeenCalledOnce();
      expect(Reflect.get(rig.controller, "pendingDialogContinuation")).toBeUndefined();
    }
  );

  it("captures a confirm resolved through a nested-frame ref before any observation", async () => {
    const rig = pendingHarness("confirm", "Nested frame decision?", false, {
      nestedFrame: true
    });

    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected nested-frame pending dialog");
    expect(pending.dialog).toMatchObject({
      message: "Nested frame decision?",
      pageUrl: "https://example.test/form",
      type: "confirm"
    });
    expect(rig.click).toHaveBeenCalledOnce();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();

    await expect(rig.controller.decidePendingDialog({
      claimantId: "nested-frame-owner",
      decision: { kind: "dismiss" },
      identity: pending.dialog
    })).resolves.toMatchObject({ ok: true });
    expect(rig.dismiss).toHaveBeenCalledOnce();
    expect(rig.settleDom).toHaveBeenCalledOnce();
    expect(rig.snapshot).toHaveBeenCalledOnce();
  });

  it("binds navigation-time dialog identity and observes only after its decision", async () => {
    const navigationUrl = "https://example.test/after-navigation";
    const rig = pendingHarness("confirm", "Continue navigation?", false, {
      navigationUrl
    });

    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected navigation-time pending dialog");
    expect(pending.dialog.pageUrl).toBe(navigationUrl);
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();

    await expect(rig.controller.decidePendingDialog({
      claimantId: "navigation-owner",
      decision: { kind: "accept" },
      identity: pending.dialog
    })).resolves.toMatchObject({
      ok: true,
      snapshot: { title: "After navigation", url: navigationUrl }
    });
    expect(rig.accept).toHaveBeenCalledOnce();
    expect(rig.settleDom).toHaveBeenCalledOnce();
    expect(rig.snapshot).toHaveBeenCalledOnce();
  });

  it.each([
    {
      field: "dialogId",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, dialogId: "dlg_missing" }),
      reason: "dialog-not-found"
    },
    {
      field: "sessionIncarnation",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, sessionIncarnation: "session-other" }),
      reason: "identity-mismatch"
    },
    {
      field: "pageTargetId",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, pageTargetId: "page-other" }),
      reason: "identity-mismatch"
    },
    {
      field: "generation",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, generation: identity.generation + 1 }),
      reason: "identity-mismatch"
    },
    {
      field: "type",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, type: "prompt" as const }),
      reason: "identity-mismatch"
    },
    {
      field: "message",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, message: `${identity.message} forged` }),
      reason: "identity-mismatch"
    },
    {
      field: "pageUrl",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, pageUrl: "https://evil.example.test/" }),
      reason: "identity-mismatch"
    },
    {
      field: "promptDefaultValue",
      mutate: (identity: PendingDialogIdentity) => ({ ...identity, promptDefaultValue: "forged" }),
      reason: "identity-mismatch"
    }
  ])("rejects a stale or forged $field with zero dialog effect", async ({ mutate, reason }) => {
    const rig = pendingHarness();
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    await expect(rig.controller.decidePendingDialog({
      claimantId: "forged-owner",
      decision: { kind: "accept" },
      identity: mutate(pending.dialog)
    })).resolves.toEqual({ ok: false, reason });
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();

    await expect(rig.controller.decidePendingDialog({
      claimantId: "valid-owner",
      decision: { kind: "dismiss" },
      identity: pending.dialog
    })).resolves.toMatchObject({ ok: true });
    expect(rig.dismiss).toHaveBeenCalledOnce();
  });

  it("fails a locator timeout without success authority and permits a clean retry", async () => {
    const rig = pendingHarness();
    const timeout = Object.assign(new Error("locator click timed out"), {
      name: "TimeoutError"
    });
    rig.click.mockRejectedValueOnce(timeout);

    await expect(rig.controller.clickWithPendingDialog(1)).rejects.toThrow(
      "locator click timed out"
    );
    expect(rig.accept).not.toHaveBeenCalled();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
    expect(Reflect.get(rig.controller, "pendingDialogCapture")).toBeUndefined();
    expect(Reflect.get(rig.controller, "pendingDialogContinuation")).toBeUndefined();

    const retry = await rig.controller.clickWithPendingDialog(1);
    if (retry.status !== "pending") throw new Error("expected clean retry authority");
    await expect(rig.controller.decidePendingDialog({
      claimantId: "retry-owner",
      decision: { kind: "dismiss" },
      identity: retry.dialog
    })).resolves.toMatchObject({ ok: true });
    expect(rig.dismiss).toHaveBeenCalledOnce();
  });

  it("lets page close terminally win while a live decision executor is pending", async () => {
    const rig = pendingHarness();
    let releaseDecision!: () => void;
    rig.accept.mockImplementation(async () => new Promise<void>((resolve) => {
      releaseDecision = resolve;
    }));
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    const deciding = rig.controller.decidePendingDialog({
      claimantId: "owner-before-page-close",
      decision: { kind: "accept" },
      identity: pending.dialog
    });
    expect(rig.accept).toHaveBeenCalledOnce();
    rig.closePage();
    releaseDecision();

    await expect(deciding).resolves.toEqual({ ok: false, reason: "terminal" });
    expect(rig.accept).toHaveBeenCalledOnce();
    expect(rig.dismiss).not.toHaveBeenCalled();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
  });

  it("allows only one concurrent controller decision and one continuation", async () => {
    const rig = pendingHarness();
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    const [first, second] = await Promise.all([
      rig.controller.decidePendingDialog({
        claimantId: "concurrent-owner-1",
        decision: { kind: "accept" },
        identity: pending.dialog
      }),
      rig.controller.decidePendingDialog({
        claimantId: "concurrent-owner-2",
        decision: { kind: "dismiss" },
        identity: pending.dialog
      })
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toHaveLength(1);
    expect(rig.accept.mock.calls.length + rig.dismiss.mock.calls.length).toBe(1);
    expect(rig.settleDom).toHaveBeenCalledOnce();
    expect(rig.snapshot).toHaveBeenCalledOnce();
  });

  it("returns a factual receipt but never success when continuation is cancelled after acknowledgement", async () => {
    const rig = pendingHarness("confirm", "Cancel after acknowledgement?", false, {
      rejectActionAfterDecision: true
    });
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    await expect(rig.controller.decidePendingDialog({
      claimantId: "cancelled-continuation-owner",
      decision: { kind: "accept" },
      identity: pending.dialog
    })).resolves.toMatchObject({
      ok: false,
      reason: "continuation-failed",
      receipt: {
        decision: { kind: "accept" },
        status: "acknowledged"
      }
    });
    expect(rig.accept).toHaveBeenCalledOnce();
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
  });

  it.each(["page-close", "disconnect"] as const)(
    "abandons pending authority on %s without a live decision",
    async (lifecycle) => {
      const rig = pendingHarness();
      const pending = await rig.controller.clickWithPendingDialog(1);
      if (pending.status !== "pending") throw new Error("expected pending dialog");

      if (lifecycle === "page-close") rig.closePage();
      else await rig.controller.disconnect();

      expect(await rig.controller.decidePendingDialog({
        claimantId: "owner-after-close",
        decision: { kind: "accept" },
        identity: pending.dialog
      })).toEqual({ ok: false, reason: "terminal" });
      expect(rig.accept).not.toHaveBeenCalled();
      expect(rig.dismiss).not.toHaveBeenCalled();
      expect(rig.settleDom).not.toHaveBeenCalled();
      expect(rig.snapshot).not.toHaveBeenCalled();
      const actionCleanup = Reflect.get(rig.controller, "pendingDialogActionCleanup") as Promise<void> | undefined;
      await actionCleanup;
      expect(rig.browser.listenerCount("targetcreated")).toBe(0);
      expect(Reflect.get(rig.controller, "pendingDialogActionCleanup")).toBeUndefined();
    }
  );

  it("lets disconnect terminally win while a live decision executor is pending", async () => {
    const rig = pendingHarness();
    let releaseDecision!: () => void;
    rig.accept.mockImplementation(async () => new Promise<void>((resolve) => {
      releaseDecision = resolve;
    }));
    const pending = await rig.controller.clickWithPendingDialog(1);
    if (pending.status !== "pending") throw new Error("expected pending dialog");

    const deciding = rig.controller.decidePendingDialog({
      claimantId: "owner-request-1",
      decision: { kind: "accept" },
      identity: pending.dialog
    });
    expect(rig.accept).toHaveBeenCalledOnce();
    await rig.controller.disconnect();
    releaseDecision();

    await expect(deciding).resolves.toEqual({ ok: false, reason: "terminal" });
    expect(rig.settleDom).not.toHaveBeenCalled();
    expect(rig.snapshot).not.toHaveBeenCalled();
  });
});
