import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  classifyFileKind,
  createFileReadTool,
  rankFileCandidates,
  resolveFileKind,
  sniffFileKind,
  type FileCandidate
} from "./file-read-tool.js";

const ctx = { runId: "r", userId: "u1" };

const candidates: FileCandidate[] = [
  { modifiedMs: 100, name: "invoice-2026-05.pdf", path: "/dl/invoice-2026-05.pdf" },
  { modifiedMs: 300, name: "invoice-2026-06.pdf", path: "/dl/invoice-2026-06.pdf" },
  { modifiedMs: 200, name: "report.md", path: "/docs/report.md" },
  { modifiedMs: 400, name: "holiday-photo.png", path: "/dl/holiday-photo.png" }
];

describe("rankFileCandidates — the model NAMES the file, code grounds it", () => {
  it("name containment beats recency; among equal matches the newest wins", () => {
    const ranked = rankFileCandidates(candidates, "invoice");
    expect(ranked.map((c) => c.name)).toEqual(["invoice-2026-06.pdf", "invoice-2026-05.pdf"]);
  });

  it("exact filename outranks containment", () => {
    const ranked = rankFileCandidates(candidates, "report.md");
    expect(ranked[0]?.name).toBe("report.md");
  });

  it("no match returns empty (the tool then lists recent files instead of guessing)", () => {
    expect(rankFileCandidates(candidates, "tax-return")).toEqual([]);
  });
});

describe("classifyFileKind — extension routing", () => {
  it("routes pdf / text / unsupported", () => {
    expect(classifyFileKind("a.PDF")).toBe("pdf");
    expect(classifyFileKind("notes.md")).toBe("text");
    expect(classifyFileKind("data.json")).toBe("text");
    expect(classifyFileKind("photo.png")).toBe("unsupported");
    expect(classifyFileKind("archive.zip")).toBe("unsupported");
  });
});

describe("file_read tool — bounded, fail-closed resolution", () => {
  const fakeFs = {
    listCandidates: async () => candidates,
    readFile: async (path: string) => {
      if (path.endsWith(".md")) return Buffer.from("# Report\nAll good.");
      if (path.endsWith(".png")) return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]); // real PNG header (NUL → binary)
      return Buffer.from("%PDF-1.4 ...");
    },
    stat: async () => ({ mtimeMs: 300, size: 1000 })
  };

  it("is a well-formed read tool", () => {
    const tool = createFileReadTool({ extractPdfText: async () => "", fsImpl: fakeFs, roots: ["/dl"] });
    expect(tool.definition.name).toBe("file_read");
    expect(tool.definition.risk).toBe("read");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("resolves a name fragment to the newest match and reads text", async () => {
    const tool = createFileReadTool({ extractPdfText: async () => "", fsImpl: fakeFs, roots: ["/docs"] });
    const out = await tool.execute({ file: "report" }, ctx) as { read: boolean; path: string; text: string };
    expect(out.read).toBe(true);
    expect(out.path).toBe("/docs/report.md");
    expect(out.text).toContain("All good");
  });

  it("routes a .pdf through the injected extractor", async () => {
    const tool = createFileReadTool({ extractPdfText: async () => "PDF BODY TEXT", fsImpl: fakeFs, roots: ["/dl"] });
    const out = await tool.execute({ file: "invoice" }, ctx) as { read: boolean; text: string; path: string };
    expect(out).toMatchObject({ path: "/dl/invoice-2026-06.pdf", read: true, text: "PDF BODY TEXT" });
  });

  it("an unmatched name lists recent files instead of reading anything", async () => {
    const tool = createFileReadTool({ extractPdfText: async () => "", fsImpl: fakeFs, roots: ["/dl"] });
    const out = await tool.execute({ file: "tax-return" }, ctx) as { read: boolean; recent?: string[] };
    expect(out.read).toBe(false);
    expect(out.recent?.length).toBeGreaterThan(0);
  });

  it("an absolute path OUTSIDE the roots is refused (no read)", async () => {
    let reads = 0;
    const tool = createFileReadTool({
      extractPdfText: async () => "",
      fsImpl: { ...fakeFs, readFile: async (p: string) => { reads += 1; return Buffer.from(p); } },
      roots: ["/dl"]
    });
    const out = await tool.execute({ file: "/etc/passwd" }, ctx) as { read: boolean };
    expect(out.read).toBe(false);
    expect(reads).toBe(0);
  });

  it("an unsupported kind is refused with a reason", async () => {
    const tool = createFileReadTool({ extractPdfText: async () => "", fsImpl: fakeFs, roots: ["/dl"] });
    const out = await tool.execute({ file: "holiday-photo" }, ctx) as { read: boolean; reason?: string };
    expect(out.read).toBe(false);
    expect(out.reason).toContain("photo.png");
  });
});

describe("sniffFileKind — content classification by magic bytes / printable ratio", () => {
  it("recognizes a PDF by its %PDF magic regardless of name", () => {
    expect(sniffFileKind(Buffer.from("%PDF-1.7\n..."))).toBe("pdf");
  });

  it("treats high-printable UTF-8 content as text", () => {
    expect(sniffFileKind(Buffer.from("# Title\n한국어도 OK\nplain text body"))).toBe("text");
  });

  it("treats NUL-containing / binary content as unsupported", () => {
    expect(sniffFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))).toBe("unsupported"); // PNG header + NUL
    expect(sniffFileKind(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe("unsupported");
  });

  it("empty data is unsupported", () => {
    expect(sniffFileKind(Buffer.from(""))).toBe("unsupported");
  });
});

describe("resolveFileKind — extension + content, magic wins on mismatch", () => {
  it("a .txt whose bytes are actually a PDF routes to pdf", () => {
    expect(resolveFileKind("invoice.txt", Buffer.from("%PDF-1.4 ..."))).toBe("pdf");
  });

  it("a NO-extension file with text bytes reads as text (extension allowlist would have refused)", () => {
    expect(resolveFileKind("README", Buffer.from("just some notes"))).toBe("text");
  });

  it("a known text extension is trusted even with odd content", () => {
    expect(resolveFileKind("script.ts", Buffer.from("const x = 1;"))).toBe("text");
  });

  it("an unknown extension with binary bytes stays unsupported", () => {
    expect(resolveFileKind("blob.dat", Buffer.from([0x00, 0xff, 0x00]))).toBe("unsupported");
  });
});

describe("file_read tool — content-sniff integration", () => {
  it("reads a no-extension file whose bytes are text (was refused by extension-only)", async () => {
    const cands: FileCandidate[] = [{ modifiedMs: 1, name: "meeting-notes", path: "/dl/meeting-notes" }];
    const fs = { listCandidates: async () => cands, readFile: async () => Buffer.from("Q3 plan: ship the thing") };
    const tool = createFileReadTool({ extractPdfText: async () => "", fsImpl: fs, roots: ["/dl"] });
    const out = await tool.execute({ file: "meeting-notes" }, ctx) as { read: boolean; text?: string };
    expect(out.read).toBe(true);
    expect(out.text).toContain("Q3 plan");
  });

  it("routes a mislabeled .txt-that-is-a-PDF through the extractor", async () => {
    const cands: FileCandidate[] = [{ modifiedMs: 1, name: "scan.txt", path: "/dl/scan.txt" }];
    const fs = { listCandidates: async () => cands, readFile: async () => Buffer.from("%PDF-1.5 binary...") };
    const tool = createFileReadTool({ extractPdfText: async () => "EXTRACTED PDF", fsImpl: fs, roots: ["/dl"] });
    const out = await tool.execute({ file: "scan.txt" }, ctx) as { read: boolean; text?: string };
    expect(out).toMatchObject({ read: true, text: "EXTRACTED PDF" });
  });
});
