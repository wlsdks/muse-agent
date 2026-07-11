import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createBrowserBackTool,
  createBrowserLookTool,
  createBrowserClickTool,
  createBrowserFillFormTool,
  createBrowserHoverTool,
  createBrowserKeyTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
  createBrowserTypeTool,
  createBrowserWaitTool,
  statusFields,
  type BrowserApprovalGate
} from "../src/browser-tools.js";
import type { BrowserController, PageSnapshot, SnapshotElement, WaitCondition, WaitOutcome } from "../src/controller.js";

const ctx = { runId: "r", userId: "u1" };

const SNAP: PageSnapshot = {
  elements: [
    { name: "Sign in", ref: 3, role: "button" },
    { name: "Email", ref: 5, role: "textbox" }
  ],
  text: "welcome",
  title: "Example",
  url: "https://example.test/"
};

class FakeController implements BrowserController {
  calls: string[] = [];
  private readonly elements = new Map<number, SnapshotElement>([
    [3, { name: "Sign in", ref: 3, role: "button" }],
    [5, { name: "Email", ref: 5, role: "textbox" }]
  ]);
  async open(url: string): Promise<PageSnapshot> { this.calls.push(`open:${url}`); return SNAP; }
  async snapshot(): Promise<PageSnapshot> { this.calls.push("snapshot"); return SNAP; }
  async click(ref: number): Promise<PageSnapshot> { this.calls.push(`click:${ref.toString()}`); return SNAP; }
  async hover(ref: number): Promise<PageSnapshot> { this.calls.push(`hover:${ref.toString()}`); return SNAP; }
  async pressKey(key: string): Promise<PageSnapshot> { this.calls.push(`key:${key}`); return SNAP; }
  async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> { this.calls.push(`type:${ref.toString()}:${text}:${submit.toString()}`); return SNAP; }
  async back(): Promise<PageSnapshot> { this.calls.push("back"); return SNAP; }
  async scroll(direction: string): Promise<PageSnapshot> { this.calls.push(`scroll:${direction}`); return SNAP; }
  waitOutcome: WaitOutcome = { matched: true, snapshot: SNAP };
  async waitFor(condition: WaitCondition): Promise<WaitOutcome> {
    this.calls.push(`wait:${condition.selector ?? condition.text ?? ""}:${(condition.timeoutMs ?? "").toString()}`);
    return this.waitOutcome;
  }
  async screenshot(path: string): Promise<{ readonly path: string }> { this.calls.push("shot"); return { path }; }
  async screenshotBase64(): Promise<string> { this.calls.push("shot-base64"); return "aW1n"; }
  describeElement(ref: number): SnapshotElement | undefined { return this.elements.get(ref); }
  currentUrl(): string { return "https://example.test/"; }
  async disconnect(): Promise<void> { this.calls.push("disconnect"); }
  async close(): Promise<void> { this.calls.push("close"); }
}

const allow: BrowserApprovalGate = () => ({ approved: true });

describe("browser_read — linkCount", () => {
  it("counts ONLY links, not every element (discriminating: 2 links among 4 elements)", async () => {
    const mixedSnap: PageSnapshot = {
      elements: [
        { name: "Home", ref: 1, role: "link", url: "https://example.test/home" },
        { name: "Pricing", ref: 2, role: "link", url: "https://example.test/pricing" },
        { name: "Sign in", ref: 3, role: "button" },
        { name: "Email", ref: 5, role: "textbox" }
      ],
      text: "nav",
      title: "Example",
      url: "https://example.test/"
    };
    const c = new FakeController();
    c.snapshot = async () => mixedSnap;
    // 4 elements, 2 of them links — a "count all elements" bug would return 4.
    expect(await createBrowserReadTool({ controller: c }).execute({}, ctx)).toMatchObject({ linkCount: 2, total: 4 });
  });
  it("omits linkCount entirely when the page has no links (no false zero noise)", async () => {
    const c = new FakeController(); // default SNAP = 1 button + 1 textbox, 0 links
    const out = await createBrowserReadTool({ controller: c }).execute({}, ctx) as Record<string, unknown>;
    expect("linkCount" in out).toBe(false);
  });
});

describe("browser tools — well-formed definitions", () => {
  it("all tools are validateToolDefinitions-clean with the browser domain", () => {
    const c = new FakeController();
    const tools = [
      createBrowserOpenTool({ controller: c }),
      createBrowserReadTool({ controller: c }),
      createBrowserBackTool({ controller: c }),
      createBrowserScrollTool({ controller: c }),
      createBrowserWaitTool({ controller: c }),
      createBrowserHoverTool({ controller: c }),
      createBrowserKeyTool({ controller: c }),
      createBrowserClickTool({ approvalGate: allow, controller: c }),
      createBrowserTypeTool({ approvalGate: allow, controller: c })
    ];
    expect(tools.map((t) => t.definition.name)).toEqual([
      "browser_open", "browser_read", "browser_back", "browser_scroll", "browser_wait", "browser_hover", "browser_key", "browser_click", "browser_type"
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
    expect(createBrowserWaitTool({ controller: c }).definition.risk).toBe("read");
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
    expect(out.elements).toEqual([
      { name: "Sign in", ref: 3, role: "button" },
      { name: "Email", ref: 5, role: "textbox" }
    ]);
    expect(c.calls).toEqual(["open:https://example.test/"]);
  });

  it("read and back return snapshots", async () => {
    const c = new FakeController();
    expect(await createBrowserReadTool({ controller: c }).execute({}, ctx)).toMatchObject({ title: "Example" });
    expect(await createBrowserBackTool({ controller: c }).execute({}, ctx)).toMatchObject({ title: "Example" });
    expect(c.calls).toEqual(["snapshot", "back"]);
  });
});

describe("browser_wait — wait for async content, honest matched signal", () => {
  it("rejects a call with neither forText nor selector without touching the browser", async () => {
    const c = new FakeController();
    const out = await createBrowserWaitTool({ controller: c }).execute({}, ctx);
    expect(out).toMatchObject({ error: expect.stringContaining("forText") });
    expect(c.calls).toEqual([]);
  });

  it("waits for a text substring and returns matched:true with the settled page", async () => {
    const c = new FakeController();
    const out = await createBrowserWaitTool({ controller: c }).execute({ forText: "results" }, ctx) as { matched: boolean; title: string };
    expect(out.matched).toBe(true);
    expect(out.title).toBe("Example");
    expect(c.calls).toEqual(["wait:results:"]);
  });

  it("passes a selector and a bounded timeout through to the controller", async () => {
    const c = new FakeController();
    await createBrowserWaitTool({ controller: c }).execute({ selector: ".search-result", timeoutMs: 8000 }, ctx);
    expect(c.calls).toEqual(["wait:.search-result:8000"]);
  });

  it("a timeout reports matched:false + timedOut + an honesty note, never a fabricated success", async () => {
    const c = new FakeController();
    c.waitOutcome = { matched: false, snapshot: SNAP };
    const out = await createBrowserWaitTool({ controller: c }).execute({ forText: "never appears" }, ctx) as {
      matched: boolean; timedOut?: boolean; note?: string; title: string;
    };
    expect(out.matched).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(out.note).toContain("did not appear");
    // the live page is still returned so the model can report what IS there
    expect(out.title).toBe("Example");
  });

  it("prefers selector over forText when both are given", async () => {
    const c = new FakeController();
    await createBrowserWaitTool({ controller: c }).execute({ forText: "ignored", selector: "#results" }, ctx);
    expect(c.calls).toEqual(["wait:#results:"]);
  });
});

describe("link destinations — a link's url flows through to the model", () => {
  const LINKED: PageSnapshot = {
    elements: [
      { name: "Pricing", ref: 0, role: "link", url: "https://example.test/pricing" },
      { name: "Sign in", ref: 1, role: "button" },
      { name: "Docs", ref: 2, role: "link", url: "https://docs.example.test/" }
    ],
    text: "home",
    title: "Home",
    url: "https://example.test/"
  };

  it("browser_read returns each link's url so the model can report a destination without navigating", async () => {
    const controller = { ...new FakeController(), snapshot: async () => LINKED } as unknown as BrowserController;
    const out = await createBrowserReadTool({ controller }).execute({}, ctx) as { elements: Array<{ name: string; ref: number; role: string; url?: string }> };
    const pricing = out.elements.find((element) => element.name === "Pricing");
    expect(pricing?.url).toBe("https://example.test/pricing");
    const signIn = out.elements.find((element) => element.name === "Sign in");
    expect(signIn && "url" in signIn).toBe(false);
  });

  it("browser_open carries link urls in its snapshot too", async () => {
    const controller = { ...new FakeController(), open: async () => LINKED } as unknown as BrowserController;
    const out = await createBrowserOpenTool({ controller }).execute({ url: "https://example.test" }, ctx) as { elements: Array<{ name: string; url?: string }> };
    expect(out.elements.find((element) => element.name === "Docs")?.url).toBe("https://docs.example.test/");
  });

  it("browser_read with find keeps the matched link's url", async () => {
    const controller = { ...new FakeController(), snapshot: async () => LINKED } as unknown as BrowserController;
    const out = await createBrowserReadTool({ controller }).execute({ find: "Pricing" }, ctx) as { elements: Array<{ name: string; url?: string }> };
    expect(out.elements).toEqual([{ name: "Pricing", ref: 0, role: "link", url: "https://example.test/pricing" }]);
  });
});

describe("navigation-status fidelity — an HTTP error page must not pass for the requested content (open/back + act tools)", () => {
  const withStatus = (status: number | undefined): PageSnapshot => ({
    elements: [],
    text: "Not Found",
    title: "404 Not Found",
    url: "https://example.test/missing",
    ...(status === undefined ? {} : { httpStatus: status })
  });

  it("statusFields flags a 404 with an advisory statusError mentioning the status", () => {
    const fields = statusFields(withStatus(404)) as { httpStatus: number; statusError: string };
    expect(fields.httpStatus).toBe(404);
    expect(fields.statusError).toContain("404");
    expect(fields.statusError.toLowerCase()).toContain("error page");
  });

  it("statusFields flags a 503 (any >= 400)", () => {
    const fields = statusFields(withStatus(503)) as { httpStatus: number; statusError: string };
    expect(fields.httpStatus).toBe(503);
    expect(fields.statusError).toContain("503");
  });

  it("statusFields stays SILENT on a 200 (success < 400 → no false alarm)", () => {
    expect(statusFields(withStatus(200))).toEqual({});
  });

  it("statusFields stays SILENT when the status is absent", () => {
    expect(statusFields(withStatus(undefined))).toEqual({});
  });

  it("statusFields stays SILENT on a non-finite / NaN status", () => {
    expect(statusFields(withStatus(Number.NaN))).toEqual({});
  });

  it("browser_open on a 404 surfaces statusError but still flows the title/text", async () => {
    const controller = { ...new FakeController(), open: async () => withStatus(404) } as unknown as BrowserController;
    const out = await createBrowserOpenTool({ controller }).execute({ url: "https://example.test/missing" }, ctx) as { httpStatus?: number; statusError?: string; title: string };
    expect(out.httpStatus).toBe(404);
    expect(out.statusError).toContain("404");
    expect(out.title).toBe("404 Not Found");
  });

  it("browser_open on a 200 carries NO httpStatus / statusError (silent success)", async () => {
    const controller = { ...new FakeController(), open: async () => withStatus(200) } as unknown as BrowserController;
    const out = await createBrowserOpenTool({ controller }).execute({ url: "https://example.test/" }, ctx) as Record<string, unknown>;
    expect("httpStatus" in out).toBe(false);
    expect("statusError" in out).toBe(false);
  });

  it("browser_back surfaces a 500 error-page status", async () => {
    const controller = { ...new FakeController(), back: async () => withStatus(500) } as unknown as BrowserController;
    const out = await createBrowserBackTool({ controller }).execute({}, ctx) as { httpStatus?: number; statusError?: string };
    expect(out.httpStatus).toBe(500);
    expect(out.statusError).toContain("500");
  });

  it("a bare browser_read NEVER carries status (consume-once: the field is navigation-only)", async () => {
    const controller = { ...new FakeController(), snapshot: async () => withStatus(404) } as unknown as BrowserController;
    const out = await createBrowserReadTool({ controller }).execute({}, ctx) as Record<string, unknown>;
    expect("httpStatus" in out).toBe(false);
    expect("statusError" in out).toBe(false);
  });

  it("browser_click that lands on a 404 surfaces statusError (act-path navigation, not just open/back)", async () => {
    const controller = new FakeController();
    controller.click = async () => withStatus(404);
    const out = await createBrowserClickTool({ approvalGate: allow, controller }).execute({ target: "Sign in" }, ctx) as { clicked: boolean; httpStatus?: number; statusError?: string };
    expect(out.clicked).toBe(true);
    expect(out.httpStatus).toBe(404);
    expect(out.statusError).toContain("404");
  });

  it("browser_click landing on a 200 carries NO status (no false alarm on a normal navigation)", async () => {
    const controller = new FakeController();
    controller.click = async () => withStatus(200);
    const out = await createBrowserClickTool({ approvalGate: allow, controller }).execute({ target: "Sign in" }, ctx) as Record<string, unknown>;
    expect(out["clicked"]).toBe(true);
    expect("httpStatus" in out).toBe(false);
    expect("statusError" in out).toBe(false);
  });

  it("browser_type submit that lands on a 500 surfaces statusError", async () => {
    const controller = new FakeController();
    controller.type = async () => withStatus(500);
    const out = await createBrowserTypeTool({ approvalGate: allow, controller }).execute({ target: "Email", text: "q", submit: true }, ctx) as { typed: boolean; httpStatus?: number; statusError?: string };
    expect(out.typed).toBe(true);
    expect(out.httpStatus).toBe(500);
    expect(out.statusError).toContain("500");
  });

  it("browser_key Enter that navigates to a 404 surfaces statusError", async () => {
    const controller = new FakeController();
    controller.pressKey = async () => withStatus(404);
    const out = await createBrowserKeyTool({ approvalGate: allow, controller }).execute({ key: "Enter" }, ctx) as { httpStatus?: number; statusError?: string };
    expect(out.httpStatus).toBe(404);
    expect(out.statusError).toContain("404");
  });
});

describe("dialog passthrough — an auto-handled JS dialog is surfaced to the model", () => {
  it("includes the dialog {type,message} in the tool output when present", async () => {
    const snap: PageSnapshot = { ...SNAP, dialog: { message: "Delete this?", type: "confirm" } };
    const controller = { ...new FakeController(), open: async () => snap } as unknown as BrowserController;
    const out = await createBrowserOpenTool({ controller }).execute({ url: "https://x.test" }, ctx) as { dialog?: { type: string; message: string } };
    expect(out.dialog).toEqual({ message: "Delete this?", type: "confirm" });
  });

  it("surfaces a prompt dialog's submitted response so the model knows what text was sent", async () => {
    const snap: PageSnapshot = { ...SNAP, dialog: { message: "Enter coupon code", response: "SAVE10", type: "prompt" } };
    const controller = { ...new FakeController(), open: async () => snap } as unknown as BrowserController;
    const out = await createBrowserOpenTool({ controller }).execute({ url: "https://x.test" }, ctx) as { dialog?: { type: string; message: string; response?: string } };
    expect(out.dialog).toEqual({ message: "Enter coupon code", response: "SAVE10", type: "prompt" });
  });
});

describe("browser_key — keyboard (Escape/Tab/arrows)", () => {
  it("is a well-formed read tool with a key enum", () => {
    const tool = createBrowserKeyTool({ controller: new FakeController() });
    expect(tool.definition.name).toBe("browser_key");
    expect(tool.definition.risk).toBe("read");
    expect((tool.definition.inputSchema as { properties: { key: { enum: string[] } } }).properties.key.enum).toContain("Escape");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects an unknown key without pressing", async () => {
    const c = new FakeController();
    const tool = createBrowserKeyTool({ controller: c });
    expect(await tool.execute({ key: "F13" }, ctx)).toMatchObject({ error: expect.stringContaining("key must be one of") });
    expect(c.calls).toEqual([]);
  });

  it("presses the key and returns the new page", async () => {
    const c = new FakeController();
    const tool = createBrowserKeyTool({ controller: c });
    expect(await tool.execute({ key: "Escape" }, ctx)).toMatchObject({ title: "Example" });
    expect(c.calls).toEqual(["key:Escape"]);
  });
});

describe("browser_key — Enter is a state-changing confirm and carries the draft-first gate", () => {
  it("a navigation key (Escape/Tab/arrow) stays free — pressed with no gate", async () => {
    const c = new FakeController();
    const tool = createBrowserKeyTool({ controller: c });
    await tool.execute({ key: "Tab" }, ctx);
    expect(c.calls).toEqual(["key:Tab"]);
  });

  it("Enter with a DENYING gate is NOT pressed — a form submit cannot bypass approval", async () => {
    const c = new FakeController();
    const tool = createBrowserKeyTool({ approvalGate: () => ({ approved: false, reason: "declined" }), controller: c });
    const out = await tool.execute({ key: "Enter" }, ctx);
    expect(out).toMatchObject({ pressed: false });
    expect(c.calls).toEqual([]);
  });

  it("Enter with NO gate wired fails closed — an ungated Enter never reaches the page", async () => {
    const c = new FakeController();
    const tool = createBrowserKeyTool({ controller: c });
    const out = await tool.execute({ key: "Enter" }, ctx);
    expect(out).toMatchObject({ pressed: false });
    expect(c.calls).toEqual([]);
  });

  it("Enter with an APPROVING gate presses through, and the gate saw a key draft", async () => {
    const c = new FakeController();
    let seen: unknown;
    const tool = createBrowserKeyTool({ approvalGate: (d) => { seen = d; return { approved: true }; }, controller: c });
    await tool.execute({ key: "Enter" }, ctx);
    expect(c.calls).toEqual(["key:Enter"]);
    expect(seen).toMatchObject({ action: "key", target: "Enter" });
  });
});

describe("browser_hover — reveal hover menus", () => {
  it("is a well-formed read tool grounding a target", () => {
    const tool = createBrowserHoverTool({ controller: new FakeController() });
    expect(tool.definition.name).toBe("browser_hover");
    expect(tool.definition.risk).toBe("read");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["target"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("grounds the target and hovers it, returning the revealed page", async () => {
    const c = new FakeController();
    const tool = createBrowserHoverTool({ controller: c });
    expect(await tool.execute({ target: "Sign in" }, ctx)).toMatchObject({ title: "Example" });
    // snapshot (to resolve target) then hover the resolved ref
    expect(c.calls).toEqual(["snapshot", "hover:3"]);
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
      describeElement: (ref) => elements[ref], disconnect: async () => {}, hover: async () => snap, open: async () => snap,
      pressKey: async () => snap, screenshot: async (path) => ({ path }), scroll: async () => snap, snapshot: async () => snap, type: async () => snap
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

  it("find pages past 50 matches too — first batch carries nextOffset, offset:50 returns the rest (no loop trap)", async () => {
    const tool = createBrowserReadTool({ controller: bigController(60) }); // every name contains "link" → all 60 match
    const first = await tool.execute({ find: "link" }, ctx) as { elements: { ref: number }[]; matched: number; hasMore?: boolean; nextOffset?: number; offset?: number };
    expect(first.elements).toHaveLength(50);
    expect(first.matched).toBe(60);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(50); // the bug omitted this → the model couldn't page
    expect(first.offset).toBeUndefined();

    const second = await tool.execute({ find: "link", offset: 50 }, ctx) as { elements: { ref: number }[]; matched: number; hasMore?: boolean; offset?: number };
    expect(second.elements).toHaveLength(10); // the bug ignored offset → returned the first 50 again
    expect(second.matched).toBe(60);
    expect(second.offset).toBe(50);
    expect(second.elements[0]!.ref).toBe(50); // continues where the first batch ended
    expect(second.hasMore).toBeUndefined();
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
    expect(out.available).toEqual(['button: Sign in', 'textbox: Email']);
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

describe("browser_click / browser_type — ghost ref (not in current snapshot) is refused, never acted on", () => {
  it("a ref that IS in the current snapshot proceeds (click:3 recorded)", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ ref: 3 }, ctx) as { clicked: boolean };
    expect(out.clicked).toBe(true);
    expect(c.calls).toEqual(["click:3"]);
  });

  it("a ref NOT in the current snapshot is refused — no click, no partial side-effect", async () => {
    const c = new FakeController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ ref: 999 }, ctx) as { clicked: boolean; reason?: string };
    expect(out.clicked).toBe(false);
    expect(String(out.reason)).toMatch(/re-read|browser_read|current page/i);
    expect(c.calls.some((call) => call.startsWith("click:"))).toBe(false);
  });

  it("browser_type with a ghost ref is equally refused — no type, no partial side-effect", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ ref: 999, text: "hello" }, ctx) as { typed: boolean; reason?: string };
    expect(out.typed).toBe(false);
    expect(String(out.reason)).toMatch(/re-read|browser_read|current page/i);
    expect(c.calls.some((call) => call.startsWith("type:"))).toBe(false);
  });
});

describe("browser_click — ambiguous target is refused (fail-close), never a silent first-pick", () => {
  const twinSnap: PageSnapshot = {
    elements: [
      { name: "Delete", ref: 0, role: "button" },
      { name: "Delete", ref: 1, role: "button" }
    ],
    text: "two delete buttons", title: "Danger", url: "https://danger.test/"
  };
  class TwinController implements BrowserController {
    calls: string[] = [];
    async open(): Promise<PageSnapshot> { return twinSnap; }
    async snapshot(): Promise<PageSnapshot> { this.calls.push("snapshot"); return twinSnap; }
    async click(ref: number): Promise<PageSnapshot> { this.calls.push(`click:${ref.toString()}`); return twinSnap; }
    async hover(): Promise<PageSnapshot> { return twinSnap; }
    async pressKey(): Promise<PageSnapshot> { return twinSnap; }
    async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> { this.calls.push(`type:${ref.toString()}:${text}:${submit.toString()}`); return twinSnap; }
    async back(): Promise<PageSnapshot> { return twinSnap; }
    async scroll(): Promise<PageSnapshot> { return twinSnap; }
    async screenshot(path: string): Promise<{ readonly path: string }> { return { path }; }
    async screenshotBase64(): Promise<string> { return "aW1n"; }
    describeElement(ref: number): SnapshotElement | undefined { return twinSnap.elements[ref]; }
    currentUrl(): string { return "https://danger.test/"; }
    async disconnect(): Promise<void> {}
    async close(): Promise<void> {}
  }

  it("two identical 'Delete' buttons → no click, returns the candidates + an ordinal hint", async () => {
    const c = new TwinController();
    let gateCalled = false;
    const tool = createBrowserClickTool({ approvalGate: () => { gateCalled = true; return { approved: true }; }, controller: c });
    const out = await tool.execute({ target: "Delete" }, ctx) as { clicked: boolean; ambiguous?: { ref: number; name: string }[]; reason?: string };
    expect(out.clicked).toBe(false);
    expect(out.ambiguous).toEqual([
      { name: "Delete", ref: 0, role: "button" },
      { name: "Delete", ref: 1, role: "button" }
    ]);
    expect(String(out.reason).toLowerCase()).toMatch(/which|ambiguous|first|second/);
    // It must NOT have clicked and must NOT have asked the human to approve a guess.
    expect(c.calls).toEqual(["snapshot"]);
    expect(gateCalled).toBe(false);
  });

  it("an ordinal disambiguates → the act proceeds on the chosen one", async () => {
    const c = new TwinController();
    const tool = createBrowserClickTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ target: "the second Delete" }, ctx) as { clicked: boolean };
    expect(out.clicked).toBe(true);
    expect(c.calls).toEqual(["snapshot", "click:1"]);
  });

  it("browser_type is equally fail-close on an ambiguous field (no type, candidates returned)", async () => {
    const fieldSnap: PageSnapshot = {
      elements: [
        { name: "Amount", ref: 0, role: "textbox" },
        { name: "Amount", ref: 1, role: "textbox" }
      ],
      text: "two amount fields", title: "Form", url: "https://form.test/"
    };
    const controller = {
      ...new TwinController(),
      snapshot: async () => fieldSnap,
      describeElement: (ref: number) => fieldSnap.elements[ref]
    } as unknown as BrowserController;
    const tool = createBrowserTypeTool({ approvalGate: allow, controller });
    const out = await tool.execute({ target: "Amount", text: "100" }, ctx) as { typed: boolean; ambiguous?: unknown[] };
    expect(out.typed).toBe(false);
    expect(out.ambiguous).toHaveLength(2);
  });
});

describe("browser_type — target that is not a field is refused (fail-close), never typed into a button", () => {
  const buttonSnap: PageSnapshot = {
    elements: [
      { name: "Sign in", ref: 0, role: "button" },
      { name: "Email", ref: 1, role: "textbox" }
    ],
    text: "login page", title: "Login", url: "https://login.test/"
  };
  function buttonController(): BrowserController & { calls: string[] } {
    const calls: string[] = [];
    return {
      back: async () => buttonSnap, calls, click: async () => buttonSnap, close: async () => {}, currentUrl: () => "https://login.test/",
      describeElement: (ref) => buttonSnap.elements[ref], disconnect: async () => {}, hover: async () => buttonSnap, open: async () => buttonSnap,
      pressKey: async () => buttonSnap, screenshot: async (path) => ({ path }), screenshotBase64: async () => "aW1n", scroll: async () => buttonSnap,
      snapshot: async () => { calls.push("snapshot"); return buttonSnap; },
      type: async (ref, text, submit) => { calls.push(`type:${ref.toString()}:${text}:${submit.toString()}`); return buttonSnap; }
    };
  }

  it("typing into a button-only match: no type, no approval, lists the typeable fields", async () => {
    const c = buttonController();
    let gateCalled = false;
    const tool = createBrowserTypeTool({ approvalGate: () => { gateCalled = true; return { approved: true }; }, controller: c });
    const out = await tool.execute({ target: "Sign in", text: "secret" }, ctx) as { typed: boolean; fields?: { ref: number; name: string }[]; reason?: string };
    expect(out.typed).toBe(false);
    expect(gateCalled).toBe(false);
    expect(out.fields).toEqual([{ name: "Email", ref: 1, role: "textbox" }]);
    expect(String(out.reason).toLowerCase()).toMatch(/field|type|text/);
    // grounded the target (snapshot) but never typed
    expect(c.calls).toEqual(["snapshot"]);
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
    expect(await tool.execute({ target: "Email", text: "hi" }, ctx)).toMatchObject({ typed: false });
    expect(c.calls).toEqual(["snapshot"]);
  });

  it("the gate draft shows the typed text (and ⏎ when submitting)", async () => {
    const c = new FakeController();
    let seen: { text?: string } | undefined;
    const tool = createBrowserTypeTool({ approvalGate: (d) => { seen = d; return { approved: false }; }, controller: c });
    await tool.execute({ submit: true, target: "Email", text: "laptop" }, ctx);
    expect(seen?.text).toContain("laptop");
    expect(seen?.text).toContain("submit");
  });

  it("a CONFIRMED type resolves the target and acts with (ref, text, submit)", async () => {
    const c = new FakeController();
    const tool = createBrowserTypeTool({ approvalGate: allow, controller: c });
    expect(await tool.execute({ submit: true, target: "Email", text: "laptop" }, ctx)).toMatchObject({ typed: true });
    expect(c.calls).toEqual(["snapshot", "type:5:laptop:true"]);
  });
});

describe("display cap — model sees a small list, matcher sees all (long-page strengthening)", () => {
  const manyElements: SnapshotElement[] = Array.from({ length: 60 }, (_, i) => ({
    name: i === 55 ? "Checkout now" : `Item ${i.toString()}`,
    ref: i,
    role: i === 55 ? "button" : "link"
  }));
  const bigSnap: PageSnapshot = { elements: manyElements, text: "shop", title: "Shop", url: "https://shop.test/" };

  class BigController implements BrowserController {
    calls: string[] = [];
    async open(): Promise<PageSnapshot> { return bigSnap; }
    async snapshot(): Promise<PageSnapshot> { return bigSnap; }
    async click(ref: number): Promise<PageSnapshot> { this.calls.push(`click:${ref.toString()}`); return bigSnap; }
    async type(): Promise<PageSnapshot> { return bigSnap; }
    async back(): Promise<PageSnapshot> { return bigSnap; }
    async screenshot(path: string): Promise<{ readonly path: string }> { return { path }; }
    async screenshotBase64(): Promise<string> { return "aW1n"; }
    describeElement(ref: number): SnapshotElement | undefined { return manyElements[ref]; }
    currentUrl(): string { return "https://shop.test/"; }
    async disconnect(): Promise<void> {}
    async close(): Promise<void> {}
  }

  it("browser_open pages a long element list and reports the true total + nextOffset", async () => {
    const c = new BigController();
    const out = await createBrowserOpenTool({ controller: c }).execute({ url: "https://shop.test" }, ctx) as {
      elements: unknown[]; total: number; hasMore?: boolean; nextOffset?: number;
    };
    expect(out.elements.length).toBe(50);
    expect(out.total).toBe(60);
    expect(out.hasMore).toBe(true);
    expect(out.nextOffset).toBe(50);
  });

  it("browser_click resolves a target BEYOND the first page (matcher sees the full set)", async () => {
    const c = new BigController();
    const out = await createBrowserClickTool({ approvalGate: allow, controller: c }).execute({ target: "Checkout now" }, ctx) as { clicked: boolean };
    expect(out.clicked).toBe(true);
    expect(c.calls).toEqual(["click:55"]);
  });

  it("a small page reports no hasMore", async () => {
    const c = new FakeController();
    const out = await createBrowserOpenTool({ controller: c }).execute({ url: "https://example.test" }, ctx) as { hasMore?: boolean };
    expect(out.hasMore).toBeFalsy();
  });
});

describe("browser_open — scheme guard (http/https only; no local-file read via file://)", () => {
  it("refuses file:// without touching the browser (file_read is the bounded local path)", async () => {
    const c = new FakeController();
    const out = await createBrowserOpenTool({ controller: c }).execute({ url: "file:///etc/passwd" }, ctx) as { error?: string };
    expect(out.error).toBeTruthy();
    expect(String(out.error).toLowerCase()).toMatch(/http|scheme|file/);
    expect(c.calls).toEqual([]);
  });

  it("refuses chrome:// / view-source: / javascript: / data: schemes", async () => {
    const c = new FakeController();
    for (const url of ["chrome://settings", "view-source:https://x.test", "javascript:alert(1)", "data:text/html,<h1>x</h1>"]) {
      const out = await createBrowserOpenTool({ controller: c }).execute({ url }, ctx) as { error?: string };
      expect(out.error).toBeTruthy();
    }
    expect(c.calls).toEqual([]);
  });

  it("still opens a normal https URL", async () => {
    const c = new FakeController();
    const out = await createBrowserOpenTool({ controller: c }).execute({ url: "https://example.test" }, ctx) as { title?: string };
    expect(out.title).toBe("Example");
    expect(c.calls).toEqual(["open:https://example.test/"]);
  });

  it("accepts a bare host and normalizes it to https", async () => {
    const c = new FakeController();
    await createBrowserOpenTool({ controller: c }).execute({ url: "example.com" }, ctx);
    expect(c.calls).toEqual(["open:https://example.com/"]);
  });
});

describe("browser_look — describe the current page visually (local vision)", () => {
  it("is a well-formed READ tool", () => {
    const c = new FakeController();
    const tool = createBrowserLookTool({ controller: c, describeImage: async () => ({ ok: true, text: "x" }) });
    expect(tool.definition.name).toBe("browser_look");
    expect(tool.definition.risk).toBe("read");
    expect(tool.definition.domain).toBe("browser");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("captures the page and returns the vision description", async () => {
    const c = new FakeController();
    let seenMime = "";
    const tool = createBrowserLookTool({
      controller: c,
      describeImage: async (input) => { seenMime = input.mimeType; return { ok: true, text: "A line chart trending upward, titled Revenue." }; }
    });
    const out = await tool.execute({}, ctx) as { described: boolean; text?: string };
    expect(out.described).toBe(true);
    expect(out.text).toContain("line chart");
    expect(seenMime).toBe("image/png");
    expect(c.calls).toContain("shot-base64");
  });

  it("passes an optional question to the vision model", async () => {
    const c = new FakeController();
    let q = "";
    const tool = createBrowserLookTool({ controller: c, describeImage: async (input) => { q = input.question ?? ""; return { ok: true, text: "ok" }; } });
    await tool.execute({ question: "what does the error banner say?" }, ctx);
    expect(q).toBe("what does the error banner say?");
  });

  it("a vision failure reports described:false with the reason", async () => {
    const c = new FakeController();
    const tool = createBrowserLookTool({ controller: c, describeImage: async () => ({ ok: false, error: "vision offline" }) });
    const out = await tool.execute({}, ctx) as { described: boolean; reason?: string };
    expect(out.described).toBe(false);
    expect(String(out.reason)).toContain("offline");
  });
});

describe("browser_fill_form — multi-field, ONE draft-first approval, fail-close", () => {
  // A login-style page: two text fields + a submit button. The default
  // FakeController has only one typeable field, so fill_form needs a richer one.
  const FORM_SNAP: PageSnapshot = {
    elements: [
      { name: "Email", ref: 1, role: "textbox" },
      { name: "Password", ref: 2, role: "textbox" },
      { name: "Log in", ref: 3, role: "button" }
    ],
    text: "login",
    title: "Login",
    url: "https://app.test/login"
  };
  class FormController implements BrowserController {
    calls: string[] = [];
    private readonly map = new Map<number, SnapshotElement>(FORM_SNAP.elements.map((e) => [e.ref, e]));
    async open(): Promise<PageSnapshot> { return FORM_SNAP; }
    async snapshot(): Promise<PageSnapshot> { this.calls.push("snapshot"); return FORM_SNAP; }
    async click(ref: number): Promise<PageSnapshot> { this.calls.push(`click:${ref.toString()}`); return FORM_SNAP; }
    async hover(ref: number): Promise<PageSnapshot> { this.calls.push(`hover:${ref.toString()}`); return FORM_SNAP; }
    async pressKey(key: string): Promise<PageSnapshot> { this.calls.push(`key:${key}`); return FORM_SNAP; }
    async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> { this.calls.push(`type:${ref.toString()}:${text}:${submit.toString()}`); return FORM_SNAP; }
    async back(): Promise<PageSnapshot> { return FORM_SNAP; }
    async scroll(): Promise<PageSnapshot> { return FORM_SNAP; }
    async waitFor(): Promise<WaitOutcome> { return { matched: true, snapshot: FORM_SNAP }; }
    async screenshot(path: string): Promise<{ readonly path: string }> { return { path }; }
    async screenshotBase64(): Promise<string> { return "aW1n"; }
    describeElement(ref: number): SnapshotElement | undefined { return this.map.get(ref); }
    currentUrl(): string { return "https://app.test/login"; }
    async disconnect(): Promise<void> {}
    async close(): Promise<void> {}
  }
  const twoFields = [{ target: "Email", value: "a@b.com" }, { target: "Password", value: "hunter2" }];

  it("is a well-formed execute-risk tool requiring a `fields` array of >=2 items", () => {
    const tool = createBrowserFillFormTool({ approvalGate: allow, controller: new FormController() });
    expect(tool.definition.name).toBe("browser_fill_form");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["fields"]);
    expect((tool.definition.inputSchema as { properties: { fields: { minItems: number } } }).properties.fields.minItems).toBe(2);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("CONFIRMED ⇒ every field filled (one type call per resolved field, in order)", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ fields: twoFields }, ctx) as { filled: boolean; fields: number };
    expect(out.filled).toBe(true);
    expect(out.fields).toBe(2);
    expect(c.calls).toEqual(["snapshot", "snapshot", "type:1:a@b.com:false", "type:2:hunter2:false"]);
  });

  it("submit true presses Enter ONLY on the last field (no mid-form submit)", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: allow, controller: c });
    await tool.execute({ fields: twoFields, submit: true }, ctx);
    expect(c.calls).toEqual(["snapshot", "snapshot", "type:1:a@b.com:false", "type:2:hunter2:true"]);
  });

  it("the ONE approval draft contains ALL field→value pairs (resolved labels)", async () => {
    const c = new FormController();
    let seen: { action?: string; fields?: { target: string; value: string }[] } = {};
    const tool = createBrowserFillFormTool({ approvalGate: (d) => { seen = d; return { approved: true }; }, controller: c });
    await tool.execute({ fields: twoFields }, ctx);
    expect(seen.action).toBe("fill");
    expect(seen.fields).toEqual([
      { target: 'textbox "Email"', value: "a@b.com" },
      { target: 'textbox "Password"', value: "hunter2" }
    ]);
  });

  it("DENIED gate ⇒ ZERO type calls (no partial fill)", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: () => ({ approved: false, reason: "declined" }), controller: c });
    const out = await tool.execute({ fields: twoFields }, ctx) as { filled: boolean; reason?: string };
    expect(out.filled).toBe(false);
    expect(out.reason).toBe("declined");
    expect(c.calls.some((call) => call.startsWith("type:"))).toBe(false);
  });

  it("an approval-gate THROW fails closed ⇒ no fill", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: () => { throw new Error("gate down"); }, controller: c });
    const out = await tool.execute({ fields: twoFields }, ctx) as { filled: boolean; reason?: string };
    expect(out.filled).toBe(false);
    expect(String(out.reason)).toContain("gate down");
    expect(c.calls.some((call) => call.startsWith("type:"))).toBe(false);
  });

  it("ONE unfound target ⇒ fail-close, ZERO type calls, the bad field + available surfaced (no gate)", async () => {
    const c = new FormController();
    let gateCalled = false;
    const tool = createBrowserFillFormTool({ approvalGate: () => { gateCalled = true; return { approved: true }; }, controller: c });
    const out = await tool.execute({ fields: [{ target: "Email", value: "a@b.com" }, { target: "Nonexistent box", value: "x" }] }, ctx) as { filled: boolean; field?: string; available?: string[] };
    expect(out.filled).toBe(false);
    expect(out.field).toBe("Nonexistent box");
    expect(Array.isArray(out.available)).toBe(true);
    expect(gateCalled).toBe(false);
    expect(c.calls.some((call) => call.startsWith("type:"))).toBe(false);
  });

  it("ONE non-typeable target (a button) ⇒ fail-close, ZERO type calls, fields listed (no gate)", async () => {
    const c = new FormController();
    let gateCalled = false;
    const tool = createBrowserFillFormTool({ approvalGate: () => { gateCalled = true; return { approved: true }; }, controller: c });
    const out = await tool.execute({ fields: [{ target: "Email", value: "a@b.com" }, { target: "Log in", value: "x" }] }, ctx) as { filled: boolean; field?: string; fields?: unknown };
    expect(out.filled).toBe(false);
    expect(out.field).toBe("Log in");
    expect(gateCalled).toBe(false);
    expect(c.calls.some((call) => call.startsWith("type:"))).toBe(false);
  });

  it("a single-field list is refused (that is browser_type's job) — no browser touch", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ fields: [{ target: "Email", value: "a@b.com" }] }, ctx) as { filled: boolean; reason?: string };
    expect(out.filled).toBe(false);
    expect(String(out.reason)).toContain("browser_type");
    expect(c.calls).toEqual([]);
  });

  it("a field with an empty value is rejected before any resolve/fill", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ fields: [{ target: "Email", value: "a@b.com" }, { target: "Password", value: "" }] }, ctx) as { filled: boolean; reason?: string };
    expect(out.filled).toBe(false);
    expect(String(out.reason)).toContain("Password");
    expect(c.calls).toEqual([]);
  });

  it("a non-array fields arg is rejected with guidance (no browser touch)", async () => {
    const c = new FormController();
    const tool = createBrowserFillFormTool({ approvalGate: allow, controller: c });
    const out = await tool.execute({ fields: "Email=a@b.com" }, ctx) as { filled: boolean; reason?: string };
    expect(out.filled).toBe(false);
    expect(String(out.reason)).toContain("fields");
    expect(c.calls).toEqual([]);
  });
});
