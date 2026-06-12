import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createWebDownloadTool, safeDownloadName } from "./web-download-tool.js";

const ctx = { runId: "r", userId: "u1" };
const dir = () => mkdtempSync(join(tmpdir(), "muse-dl-"));
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function fakeFetch(body: Buffer, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status, headers })) as unknown as typeof fetch;
}

describe("safeDownloadName — basename only, no traversal", () => {
  it("strips directories and traversal, keeps the basename", () => {
    expect(safeDownloadName("../../etc/passwd", "https://x/y")).toBe("passwd");
    expect(safeDownloadName("/abs/report.pdf", "https://x/y")).toBe("report.pdf");
    expect(safeDownloadName("..", "https://x/a/invoice.pdf")).toBe("invoice.pdf");
  });
  it("derives the name from the URL when none is given", () => {
    expect(safeDownloadName(undefined, "https://x.com/files/budget.xlsx?v=2")).toBe("budget.xlsx");
  });
  it("falls back to a default when nothing usable", () => {
    expect(safeDownloadName(undefined, "https://x.com/")).toMatch(/^download/);
  });
});

describe("web_download tool", () => {
  it("is a well-formed execute tool requiring url", () => {
    const tool = createWebDownloadTool({ downloadDir: dir(), fetchImpl: fakeFetch(Buffer.from("x")), lookup: publicLookup });
    expect(tool.definition.name).toBe("web_download");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["url"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("downloads a public URL to the downloads dir and reports the path", async () => {
    const d = dir();
    const tool = createWebDownloadTool({ downloadDir: d, fetchImpl: fakeFetch(Buffer.from("PDF-BYTES")), lookup: publicLookup });
    const out = await tool.execute({ url: "https://files.test/report.pdf" }, ctx) as { saved: boolean; path: string; name: string };
    expect(out.saved).toBe(true);
    expect(out.name).toBe("report.pdf");
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path, "utf8")).toBe("PDF-BYTES");
  });

  it("SSRF: a loopback URL is refused without writing", async () => {
    const d = dir();
    let fetched = false;
    const tool = createWebDownloadTool({ downloadDir: d, fetchImpl: (async () => { fetched = true; return new Response("x"); }) as unknown as typeof fetch });
    const out = await tool.execute({ url: "http://127.0.0.1/secret" }, ctx) as { saved: boolean; reason?: string };
    expect(out.saved).toBe(false);
    expect(fetched).toBe(false);
  });

  it("refuses a non-http(s) scheme", async () => {
    const tool = createWebDownloadTool({ downloadDir: dir(), fetchImpl: fakeFetch(Buffer.from("x")), lookup: publicLookup });
    const out = await tool.execute({ url: "file:///etc/passwd" }, ctx) as { saved: boolean };
    expect(out.saved).toBe(false);
  });

  it("refuses a file larger than the cap (no partial write)", async () => {
    const d = dir();
    const tool = createWebDownloadTool({ downloadDir: d, fetchImpl: fakeFetch(Buffer.alloc(1024)), lookup: publicLookup, maxBytes: 256 });
    const out = await tool.execute({ url: "https://files.test/big.bin" }, ctx) as { saved: boolean; reason?: string };
    expect(out.saved).toBe(false);
    expect(String(out.reason).toLowerCase()).toMatch(/large|big|size|cap/);
  });

  it("a model-named filename is sanitized to a basename (no path escape)", async () => {
    const d = dir();
    const tool = createWebDownloadTool({ downloadDir: d, fetchImpl: fakeFetch(Buffer.from("x")), lookup: publicLookup });
    const out = await tool.execute({ url: "https://files.test/x", filename: "../../evil.sh" }, ctx) as { saved: boolean; path: string; name: string };
    expect(out.saved).toBe(true);
    expect(out.name).toBe("evil.sh");
    expect(out.path.startsWith(d)).toBe(true);
  });
});
