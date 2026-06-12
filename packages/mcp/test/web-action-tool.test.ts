import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateToolDefinitions } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebActionTool, type WebActionToolDeps } from "../src/web-action-tool.js";

let dir: string;
let actionLogFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-web-tool-"));
  actionLogFile = join(dir, "actions.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const deps = (over: Partial<WebActionToolDeps> = {}): WebActionToolDeps => ({
  actionLogFile,
  approvalGate: () => ({ approved: true }),
  fetchImpl: okFetch,
  lookup: publicLookup,
  userId: "u1",
  ...over
});
const ctx = { runId: "r", userId: "u1" };

describe("createWebActionTool — the web_action MuseTool definition", () => {
  it("is a well-formed execute-risk tool requiring only summary (url clarified, never guessed) and validateToolDefinitions-clean", () => {
    const tool = createWebActionTool(deps());
    expect(tool.definition.name).toBe("web_action");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["summary"]);
    expect(schema.properties).toHaveProperty("url");
    expect(schema.additionalProperties).toBe(false);
    expect(tool.definition.keywords).toContain("예약"); // Korean selection keyword
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("its description tells the model when to use it AND when not (read / payments)", () => {
    const d = createWebActionTool(deps()).definition.description.toLowerCase();
    expect(d).toContain("use when");
    expect(d).toContain("do not use to read");
    expect(d).toContain("payments");
  });
});

describe("createWebActionTool — execute routes through the fail-closed orchestration", () => {
  it("rejects empty summary and clarifies an absent url BEFORE any orchestration (no spurious action)", async () => {
    let fetched = false;
    const tool = createWebActionTool(deps({ fetchImpl: (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch }));
    expect(await tool.execute({ summary: "", url: "https://x" }, ctx)).toMatchObject({ performed: false });
    expect(await tool.execute({ summary: "do", url: "  " }, ctx)).toMatchObject({ performed: false, reason: "needs-url" });
    expect(await tool.execute({ summary: "do" }, ctx)).toMatchObject({ performed: false, reason: "needs-url" });
    expect(fetched).toBe(false);
  });

  it("performs a confirmed action (default method POST, uppercased) and returns performed:true", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const tool = createWebActionTool(deps({ fetchImpl: (async (_u: string, init: RequestInit) => { calls.push({ init }); return new Response("", { status: 201 }); }) as unknown as typeof fetch }));
    const out = await tool.execute({ summary: "book a table", url: "https://api.test/book", method: "put" }, ctx);
    expect(out).toEqual({ performed: true, status: 201 });
    expect(calls[0]!.init.method).toBe("PUT"); // lowercased input uppercased
  });

  it("maps a denied approval to performed:false with the reason (inherits outbound-safety)", async () => {
    const tool = createWebActionTool(deps({ approvalGate: () => ({ approved: false, reason: "user declined" }) }));
    const out = await tool.execute({ summary: "book", url: "https://api.test/x" }, ctx);
    expect(out).toMatchObject({ performed: false, reason: "denied" });
  });
});
