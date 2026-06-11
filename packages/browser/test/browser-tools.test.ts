import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createBrowserBackTool,
  createBrowserClickTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTypeTool,
  type BrowserApprovalGate
} from "../src/browser-tools.js";
import type { BrowserController, PageSnapshot, SnapshotElement } from "../src/controller.js";

const ctx = { runId: "r", userId: "u1" };

const SNAP: PageSnapshot = {
  elements: [{ name: "Sign in", ref: 3, role: "button" }],
  text: "welcome",
  title: "Example",
  url: "https://example.test/"
};

class FakeController implements BrowserController {
  calls: string[] = [];
  private readonly elements = new Map<number, SnapshotElement>([[3, { name: "Sign in", ref: 3, role: "button" }]]);
  async open(url: string): Promise<PageSnapshot> { this.calls.push(`open:${url}`); return SNAP; }
  async snapshot(): Promise<PageSnapshot> { this.calls.push("snapshot"); return SNAP; }
  async click(ref: number): Promise<PageSnapshot> { this.calls.push(`click:${ref.toString()}`); return SNAP; }
  async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> { this.calls.push(`type:${ref.toString()}:${text}:${submit.toString()}`); return SNAP; }
  async back(): Promise<PageSnapshot> { this.calls.push("back"); return SNAP; }
  async screenshot(path: string): Promise<{ readonly path: string }> { this.calls.push("shot"); return { path }; }
  describeElement(ref: number): SnapshotElement | undefined { return this.elements.get(ref); }
  currentUrl(): string { return "https://example.test/"; }
  async close(): Promise<void> { this.calls.push("close"); }
}

const allow: BrowserApprovalGate = () => ({ approved: true });

describe("browser tools — well-formed definitions", () => {
  it("all five tools are validateToolDefinitions-clean with the browser domain", () => {
    const c = new FakeController();
    const tools = [
      createBrowserOpenTool({ controller: c }),
      createBrowserReadTool({ controller: c }),
      createBrowserBackTool({ controller: c }),
      createBrowserClickTool({ approvalGate: allow, controller: c }),
      createBrowserTypeTool({ approvalGate: allow, controller: c })
    ];
    expect(tools.map((t) => t.definition.name)).toEqual([
      "browser_open", "browser_read", "browser_back", "browser_click", "browser_type"
    ]);
    for (const tool of tools) {
      expect(tool.definition.domain).toBe("browser");
      expect(validateToolDefinitions([tool])).toEqual([]);
    }
    // reads/nav are not outbound; only click/type carry the act risk.
    expect(createBrowserReadTool({ controller: c }).definition.risk).toBe("read");
  });
});

describe("browser_open / read / back — free (no gate)", () => {
  it("open rejects an empty url without touching the browser", async () => {
    const c = new FakeController();
    const tool = createBrowserOpenTool({ controller: c });
    expect(await tool.execute({ url: "  " }, ctx)).toMatchObject({ error: expect.stringContaining("url") });
    expect(c.calls).toEqual([]);
  });

  it("open navigates and returns the page snapshot (title/text/elements)", async () => {
    const c = new FakeController();
    const tool = createBrowserOpenTool({ controller: c });
    const out = await tool.execute({ url: "https://example.test" }, ctx) as { url: string; title: string; elements: unknown[] };
    expect(out).toMatchObject({ title: "Example", url: "https://example.test/" });
    expect(out.elements).toEqual([{ name: "Sign in", ref: 3, role: "button" }]);
    expect(c.calls).toEqual(["open:https://example.test"]);
  });

  it("read and back return snapshots", async () => {
    const c = new FakeController();
    expect(await createBrowserReadTool({ controller: c }).execute({}, ctx)).toMatchObject({ title: "Example" });
    expect(await createBrowserBackTool({ controller: c }).execute({}, ctx)).toMatchObject({ title: "Example" });
    expect(c.calls).toEqual(["snapshot", "back"]);
  });
});

describe("browser_click — draft-first, fail-closed", () => {
  it("rejects a non-integer ref without clicking", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ ref: "x" }, ctx)).toMatchObject({ clicked: false });
    expect(c.calls).toEqual([]);
  });

  it("a DENIED gate produces no click", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: () => ({ approved: false, reason: "declined" }), controller: c });
    expect(await tool.execute({ ref: 3 }, ctx)).toMatchObject({ clicked: false, reason: "declined" });
    expect(c.calls).toEqual([]);
  });

  it("a THROWING gate is treated as denial — no click", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: () => { throw new Error("no TTY"); }, controller: c });
    expect(await tool.execute({ ref: 3 }, ctx)).toMatchObject({ clicked: false });
    expect(c.calls).toEqual([]);
  });

  it("the gate draft describes the target element + url", async () => {
    const c = new FakeController();
    let seen: { target: string; url: string; action: string } | undefined;
    const tool = createBrowserClickTool({ approvalGate: (d) => { seen = d; return { approved: false }; }, controller: c });
    await tool.execute({ ref: 3 }, ctx);
    expect(seen).toMatchObject({ action: "click", target: 'button "Sign in"', url: "https://example.test/" });
  });

  it("a CONFIRMED click acts and returns the new snapshot", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ ref: 3 }, ctx)).toMatchObject({ clicked: true, title: "Example" });
    expect(c.calls).toEqual(["click:3"]);
  });
});

describe("browser_type — draft-first, fail-closed", () => {
  it("rejects empty text without typing", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ ref: 2, text: "" }, ctx)).toMatchObject({ typed: false });
    expect(c.calls).toEqual([]);
  });

  it("a DENIED gate produces no type", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: () => ({ approved: false }), controller: c });
    expect(await tool.execute({ ref: 2, text: "hi" }, ctx)).toMatchObject({ typed: false });
    expect(c.calls).toEqual([]);
  });

  it("the gate draft shows the typed text (and ⏎ when submitting)", async () => {
    const c = new FakeController();
    let seen: { text?: string } | undefined;
    const tool = createBrowserTypeTool({ approvalGate: (d) => { seen = d; return { approved: false }; }, controller: c });
    await tool.execute({ ref: 3, submit: true, text: "laptop" }, ctx);
    expect(seen?.text).toContain("laptop");
    expect(seen?.text).toContain("submit");
  });

  it("a CONFIRMED type acts with (ref, text, submit) and returns the snapshot", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ ref: 3, submit: true, text: "laptop" }, ctx)).toMatchObject({ typed: true });
    expect(c.calls).toEqual(["type:3:laptop:true"]);
  });
});
