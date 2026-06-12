import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createBrowserBackTool,
  createBrowserClickTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
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
  async scroll(direction: string): Promise<PageSnapshot> { this.calls.push(`scroll:${direction}`); return SNAP; }
  async screenshot(path: string): Promise<{ readonly path: string }> { this.calls.push("shot"); return { path }; }
  describeElement(ref: number): SnapshotElement | undefined { return this.elements.get(ref); }
  currentUrl(): string { return "https://example.test/"; }
  async disconnect(): Promise<void> { this.calls.push("disconnect"); }
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
      createBrowserScrollTool({ controller: c }),
      createBrowserClickTool({ approvalGate: allow, controller: c }),
      createBrowserTypeTool({ approvalGate: allow, controller: c })
    ];
    expect(tools.map((t) => t.definition.name)).toEqual([
      "browser_open", "browser_read", "browser_back", "browser_scroll", "browser_click", "browser_type"
    ]);
    for (const tool of tools) {
      expect(tool.definition.domain).toBe("browser");
      expect(validateToolDefinitions([tool])).toEqual([]);
    }
    // reads/nav are not outbound; only click/type carry the act risk. The
    // exposure policy hides execute-risk tools outside localMode, so a
    // mis-classified read tool silently disappears from `--with-tools`.
    expect(createBrowserOpenTool({ controller: c }).definition.risk).toBe("read");
    expect(createBrowserReadTool({ controller: c }).definition.risk).toBe("read");
    expect(createBrowserBackTool({ controller: c }).definition.risk).toBe("read");
    expect(createBrowserClickTool({ approvalGate: allow, controller: c }).definition.risk).toBe("execute");
    expect(createBrowserTypeTool({ approvalGate: allow, controller: c }).definition.risk).toBe("execute");
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

describe("browser_scroll — reveal below-the-fold content", () => {
  it("is a well-formed read tool with a direction enum", () => {
    const c = new FakeController();
    const tool = createBrowserScrollTool({ controller: c });
    expect(tool.definition.name).toBe("browser_scroll");
    expect(tool.definition.risk).toBe("read");
    expect((tool.definition.inputSchema as { required: string[]; properties: { direction: { enum: string[] } } }).required).toEqual(["direction"]);
    expect((tool.definition.inputSchema as { properties: { direction: { enum: string[] } } }).properties.direction.enum).toEqual(["down", "up", "top", "bottom"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects an unknown direction without scrolling", async () => {
    const c = new FakeController();
    const tool = createBrowserScrollTool({ controller: c });
    expect(await tool.execute({ direction: "sideways" }, ctx)).toMatchObject({ error: expect.stringContaining("direction must be one of") });
    expect(c.calls).toEqual([]);
  });

  it("scrolls and returns the new page snapshot", async () => {
    const c = new FakeController();
    const tool = createBrowserScrollTool({ controller: c });
    expect(await tool.execute({ direction: "bottom" }, ctx)).toMatchObject({ title: "Example" });
    expect(c.calls).toEqual(["scroll:bottom"]);
  });
});

describe("browser_read — paging a long page (no silent truncation)", () => {
  function bigController(n: number): BrowserController {
    const elements: SnapshotElement[] = Array.from({ length: n }, (_v, i) => ({ name: `link ${i.toString()}`, ref: i, role: "link" }));
    const snap: PageSnapshot = { elements, text: "x", title: "Big", url: "https://big.test/" };
    return {
      back: async () => snap, click: async () => snap, close: async () => {}, currentUrl: () => "https://big.test/",
      describeElement: (ref) => elements[ref], disconnect: async () => {}, open: async () => snap,
      screenshot: async (path) => ({ path }), scroll: async () => snap, snapshot: async () => snap, type: async () => snap
    };
  }

  it("caps the response at 50 and REPORTS total + nextOffset (nothing silently dropped)", async () => {
    const tool = createBrowserReadTool({ controller: bigController(60) });
    const out = await tool.execute({}, ctx) as { elements: unknown[]; total: number; hasMore?: boolean; nextOffset?: number };
    expect(out.elements).toHaveLength(50);
    expect(out.total).toBe(60);
    expect(out.hasMore).toBe(true);
    expect(out.nextOffset).toBe(50);
  });

  it("offset reads the next batch and ends cleanly", async () => {
    const tool = createBrowserReadTool({ controller: bigController(60) });
    const out = await tool.execute({ offset: 50 }, ctx) as { elements: { ref: number }[]; offset: number; hasMore?: boolean };
    expect(out.elements).toHaveLength(10);
    expect(out.offset).toBe(50);
    expect(out.elements[0]!.ref).toBe(50);
    expect(out.hasMore).toBeUndefined();
  });
});

describe("browser_click — deterministic target grounding + draft-first", () => {
  it("with no target and no ref, asks for a target (no browser touch)", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({}, ctx)).toMatchObject({ clicked: false });
    expect(c.calls).toEqual([]);
  });

  it("resolves a free-text target to an element (code grounds it, not the model)", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    // 'the Sign in button' resolves to the button named 'Sign in' → click ref 3.
    expect(await tool.execute({ target: "the Sign in button" }, ctx)).toMatchObject({ clicked: true });
    expect(c.calls).toEqual(["snapshot", "click:3"]);
  });

  it("an unmatched target returns the available elements (no click)", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ target: "checkout" }, ctx) as { clicked: boolean; available?: string[] };
    expect(out.clicked).toBe(false);
    expect(out.available).toEqual(['button: Sign in']);
    expect(c.calls).toEqual(["snapshot"]);
  });

  it("a DENIED gate produces no click", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: () => ({ approved: false, reason: "declined" }), controller: c });
    expect(await tool.execute({ target: "Sign in" }, ctx)).toMatchObject({ clicked: false, reason: "declined" });
    expect(c.calls).toEqual(["snapshot"]);
  });

  it("the gate draft describes the resolved element + url", async () => {
    const c = new FakeController();
    let seen: { target: string; url: string; action: string } | undefined;
    const tool = createBrowserClickTool({ approvalGate: (d) => { seen = d; return { approved: false }; }, controller: c });
    await tool.execute({ target: "sign in" }, ctx);
    expect(seen).toMatchObject({ action: "click", target: 'button "Sign in"', url: "https://example.test/" });
  });
});

describe("browser_type — target grounding + draft-first", () => {
  it("rejects empty text without typing", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ target: "search", text: "" }, ctx)).toMatchObject({ typed: false });
    expect(c.calls).toEqual([]);
  });

  it("a DENIED gate produces no type", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: () => ({ approved: false }), controller: c });
    expect(await tool.execute({ target: "Sign in", text: "hi" }, ctx)).toMatchObject({ typed: false });
    expect(c.calls).toEqual(["snapshot"]);
  });

  it("the gate draft shows the typed text (and ⏎ when submitting)", async () => {
    const c = new FakeController();
    let seen: { text?: string } | undefined;
    const tool = createBrowserTypeTool({ approvalGate: (d) => { seen = d; return { approved: false }; }, controller: c });
    await tool.execute({ submit: true, target: "Sign in", text: "laptop" }, ctx);
    expect(seen?.text).toContain("laptop");
    expect(seen?.text).toContain("submit");
  });

  it("a CONFIRMED type resolves the target and acts with (ref, text, submit)", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ submit: true, target: "Sign in", text: "laptop" }, ctx)).toMatchObject({ typed: true });
    expect(c.calls).toEqual(["snapshot", "type:3:laptop:true"]);
  });
});
