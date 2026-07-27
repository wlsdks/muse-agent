import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it, vi } from "vitest";

import {
  createBrowserClickTool,
  createBrowserDialogDecisionTool,
  type BrowserActionDraft,
  type BrowserApprovalGate,
  type PendingDialogBrowserController,
  type PendingPuppeteerClickResult,
  type PendingPuppeteerDialogDecisionResult
} from "../src/index.js";
import type {
  BrowserKey,
  PageSnapshot,
  ScrollDirection,
  SnapshotElement,
  WaitCondition,
  WaitOutcome
} from "../src/controller.js";
import type { ClaimPendingDialogInput, PendingDialogIdentity } from "../src/pending-dialog-coordinator.js";

const context = { runId: "run-1", userId: "user-1" };
const snapshot: PageSnapshot = {
  elements: [{ name: "Continue", ref: 3, role: "button" }],
  text: "settled",
  title: "Settled",
  url: "https://example.test/form"
};
const promptIdentity: PendingDialogIdentity = {
  dialogId: "dlg_exact",
  generation: 3,
  message: "Enter the exact code",
  pageTargetId: "page_exact",
  pageUrl: "https://example.test/form",
  promptDefaultValue: "PAGE-DEFAULT",
  sessionIncarnation: "browser_exact",
  type: "prompt"
};

class PendingToolController implements PendingDialogBrowserController {
  readonly calls: string[] = [];
  readonly decisions: ClaimPendingDialogInput[] = [];
  clickResult: PendingPuppeteerClickResult = {
    dialog: promptIdentity,
    status: "pending"
  };
  decisionResult: PendingPuppeteerDialogDecisionResult = {
    ok: true,
    receipt: {
      claimantId: "tool:user-1:run-1",
      decision: { kind: "accept", promptResponse: "OWNER-CODE" },
      identity: promptIdentity,
      schemaVersion: "muse.browser-dialog-decision-receipt/v1",
      status: "acknowledged"
    },
    snapshot
  };

  async open(): Promise<PageSnapshot> { return snapshot; }
  async snapshot(): Promise<PageSnapshot> {
    this.calls.push("snapshot");
    return snapshot;
  }
  async click(ref: number): Promise<PageSnapshot> {
    this.calls.push(`legacy-click:${ref.toString()}`);
    return snapshot;
  }
  async clickWithPendingDialog(ref: number): Promise<PendingPuppeteerClickResult> {
    this.calls.push(`pending-click:${ref.toString()}`);
    return this.clickResult;
  }
  async decidePendingDialog(input: ClaimPendingDialogInput): Promise<PendingPuppeteerDialogDecisionResult> {
    this.calls.push("decide");
    this.decisions.push(input);
    return this.decisionResult;
  }
  async hover(): Promise<PageSnapshot> { return snapshot; }
  async type(): Promise<PageSnapshot> { return snapshot; }
  async uploadFile(): Promise<PageSnapshot> { return snapshot; }
  async back(): Promise<PageSnapshot> { return snapshot; }
  async pressKey(_key: BrowserKey): Promise<PageSnapshot> { return snapshot; }
  async scroll(_direction: ScrollDirection): Promise<PageSnapshot> { return snapshot; }
  async waitFor(_condition: WaitCondition): Promise<WaitOutcome> {
    return { matched: true, snapshot };
  }
  async screenshot(path: string): Promise<{ readonly path: string }> { return { path }; }
  async screenshotBase64(): Promise<string> { return "aW1n"; }
  describeElement(ref: number): SnapshotElement | undefined {
    return snapshot.elements.find((element) => element.ref === ref);
  }
  currentUrl(): string { return snapshot.url; }
  async hasOpenPage(): Promise<boolean> { return true; }
  async disconnect(): Promise<void> {}
  async close(): Promise<void> {}
}

function exactArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: "accept",
    dialogId: promptIdentity.dialogId,
    generation: promptIdentity.generation,
    message: promptIdentity.message,
    pageTargetId: promptIdentity.pageTargetId,
    pageUrl: promptIdentity.pageUrl,
    promptDefaultValue: promptIdentity.promptDefaultValue,
    promptResponse: "OWNER-CODE",
    sessionIncarnation: promptIdentity.sessionIncarnation,
    type: promptIdentity.type,
    ...overrides
  };
}

describe("browser pending-dialog tools", () => {
  it("returns exact pending identity without a snapshot or implicit dialog decision", async () => {
    const controller = new PendingToolController();
    const drafts: BrowserActionDraft[] = [];
    const tool = createBrowserClickTool({
      approvalGate: (draft) => {
        drafts.push(draft);
        return { approved: true };
      },
      controller,
      pendingDialogController: controller
    });

    const output = await tool.execute({ target: "Continue" }, context) as Record<string, unknown>;

    expect(output).toMatchObject({
      clicked: true,
      dialog: promptIdentity,
      status: "pending"
    });
    expect("title" in output).toBe(false);
    expect("text" in output).toBe(false);
    expect("elements" in output).toBe(false);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ action: "click" });
    expect(controller.calls).toEqual(["snapshot", "pending-click:3"]);
    expect(controller.decisions).toEqual([]);
  });

  it("returns a completed snapshot on the distinct controller path", async () => {
    const controller = new PendingToolController();
    controller.clickResult = { snapshot, status: "completed" };
    const tool = createBrowserClickTool({
      approvalGate: () => ({ approved: true }),
      controller,
      pendingDialogController: controller
    });

    await expect(tool.execute({ target: "Continue" }, context)).resolves.toMatchObject({
      clicked: true,
      status: "completed",
      title: "Settled"
    });
    expect(controller.calls).toEqual(["snapshot", "pending-click:3"]);
  });

  it("requires a second exact approval draft before accepting a prompt", async () => {
    const controller = new PendingToolController();
    let seen: BrowserActionDraft | undefined;
    const tool = createBrowserDialogDecisionTool({
      approvalGate: (draft) => {
        seen = draft;
        return { approved: true };
      },
      controller
    });

    const output = await tool.execute(exactArgs(), context);

    expect(seen).toEqual({
      action: "dialog-decision",
      dialog: promptIdentity,
      dialogDecision: { kind: "accept", promptResponse: "OWNER-CODE" },
      target: "prompt dialog",
      url: promptIdentity.pageUrl
    });
    expect(controller.decisions).toEqual([{
      claimantId: "tool:user-1:run-1",
      decision: { kind: "accept", promptResponse: "OWNER-CODE" },
      identity: promptIdentity
    }]);
    expect(output).toMatchObject({
      decided: true,
      status: "acknowledged",
      title: "Settled"
    });
  });

  it.each([
    {
      gate: (() => ({ approved: false, reason: "declined" })) as BrowserApprovalGate,
      reason: "declined"
    },
    {
      gate: (() => { throw new Error("TTY unavailable"); }) as BrowserApprovalGate,
      reason: "approval gate error"
    }
  ])("never calls the live controller when the separate gate refuses", async ({ gate, reason }) => {
    const controller = new PendingToolController();
    const tool = createBrowserDialogDecisionTool({ approvalGate: gate, controller });

    await expect(tool.execute(exactArgs(), context)).resolves.toMatchObject({
      decided: false,
      reason: expect.stringContaining(reason)
    });
    expect(controller.decisions).toEqual([]);
  });

  it.each([
    { approved: true },
    { promptResponse: undefined },
    { decision: "dismiss", promptResponse: "forged" },
    { generation: 1.5 },
    { type: "confirm", promptDefaultValue: "forged", promptResponse: undefined }
  ])("rejects malformed or authority-smuggling args before gate/controller", async (overrides) => {
    const controller = new PendingToolController();
    const gate = vi.fn(() => ({ approved: true }));
    const tool = createBrowserDialogDecisionTool({ approvalGate: gate, controller });

    await expect(tool.execute(exactArgs(overrides), context)).resolves.toMatchObject({
      decided: false
    });
    expect(gate).not.toHaveBeenCalled();
    expect(controller.decisions).toEqual([]);
  });

  it("rejects inherited and throwing input properties before gate/controller", async () => {
    const controller = new PendingToolController();
    const gate = vi.fn(() => ({ approved: true }));
    const tool = createBrowserDialogDecisionTool({ approvalGate: gate, controller });
    const inherited = Object.create(exactArgs()) as Record<string, unknown>;
    const throwing = new Proxy(exactArgs(), {
      getPrototypeOf: () => {
        throw new Error("prototype trap");
      }
    });

    await expect(tool.execute(inherited, context)).resolves.toMatchObject({
      decided: false
    });
    await expect(tool.execute(throwing, context)).resolves.toEqual({
      decided: false,
      reason: "browser_dialog_decide requires a safe own-property JSON object"
    });
    expect(gate).not.toHaveBeenCalled();
    expect(controller.decisions).toEqual([]);
  });

  it.each([
    { runId: "run-1" },
    { userId: "user-1" },
    { runId: " run-1 ", userId: "user-1" },
    { runId: "run-1", userId: "" }
  ])("requires exact current run and user authority before gate/controller", async (invalidContext) => {
    const controller = new PendingToolController();
    const gate = vi.fn(() => ({ approved: true }));
    const tool = createBrowserDialogDecisionTool({ approvalGate: gate, controller });

    await expect(
      tool.execute(exactArgs(), invalidContext as typeof context)
    ).resolves.toEqual({
      decided: false,
      reason: "browser_dialog_decide requires current runId and userId authority"
    });
    expect(gate).not.toHaveBeenCalled();
    expect(controller.decisions).toEqual([]);
  });

  it("surfaces stale/terminal controller rejection without false success", async () => {
    const controller = new PendingToolController();
    controller.decisionResult = { ok: false, reason: "terminal" };
    const tool = createBrowserDialogDecisionTool({
      approvalGate: () => ({ approved: true }),
      controller
    });

    await expect(tool.execute(exactArgs(), context)).resolves.toEqual({
      decided: false,
      reason: "terminal"
    });
  });

  it("copies a matching receipt and rejects a controller receipt that is not bound to the request", async () => {
    const controller = new PendingToolController();
    const tool = createBrowserDialogDecisionTool({
      approvalGate: () => ({ approved: true }),
      controller
    });

    const output = await tool.execute(exactArgs(), context) as {
      receipt: { decision: { kind: string; promptResponse?: string } };
    };
    const acknowledged = controller.decisionResult;
    if (!acknowledged.ok) throw new Error("expected acknowledged fixture");
    (acknowledged.receipt.decision as { kind: string; promptResponse?: string }).kind = "dismiss";
    delete (acknowledged.receipt.decision as { kind: string; promptResponse?: string }).promptResponse;
    expect(output.receipt.decision).toEqual({
      kind: "accept",
      promptResponse: "OWNER-CODE"
    });

    controller.decisionResult = {
      ...acknowledged,
      receipt: {
        ...acknowledged.receipt,
        claimantId: "tool:other-user:other-run",
        decision: { kind: "accept", promptResponse: "OWNER-CODE" }
      }
    };
    await expect(tool.execute(exactArgs(), context)).resolves.toEqual({
      decided: false,
      reason: "browser dialog controller returned a mismatched decision receipt"
    });
  });

  it("has a valid execute-risk definition and does not consume the click budget twice", async () => {
    const controller = new PendingToolController();
    const budget = { tryConsume: vi.fn(() => ({ allowed: true, label: "1/5" })) };
    const click = createBrowserClickTool({
      actionBudget: budget,
      approvalGate: () => ({ approved: true }),
      controller,
      pendingDialogController: controller
    });
    const decide = createBrowserDialogDecisionTool({
      approvalGate: () => ({ approved: true }),
      controller
    });

    expect(validateToolDefinitions([click, decide])).toEqual([]);
    expect(decide.definition.risk).toBe("execute");
    await click.execute({ target: "Continue" }, context);
    await decide.execute(exactArgs(), context);
    expect(budget.tryConsume).toHaveBeenCalledOnce();
  });
});
