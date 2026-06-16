import { describe, expect, it } from "vitest";

import {
  classifyFileKind,
  rankFileCandidates,
  resolveFileKind,
  sniffFileKind,
  type FileCandidate
} from "./fs-document.js";

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
  it("routes pdf / docx / text / image / unsupported", () => {
    expect(classifyFileKind("a.PDF")).toBe("pdf");
    expect(classifyFileKind("contract.docx")).toBe("docx");
    expect(classifyFileKind("notes.md")).toBe("text");
    expect(classifyFileKind("data.json")).toBe("text");
    expect(classifyFileKind("photo.png")).toBe("image");
    expect(classifyFileKind("archive.zip")).toBe("unsupported");
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
    expect(sniffFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))).toBe("unsupported");
    expect(sniffFileKind(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe("unsupported");
  });

  it("empty data is unsupported", () => {
    expect(sniffFileKind(Buffer.from(""))).toBe("unsupported");
  });

  it("detects PNG/JPEG image magic bytes", () => {
    expect(sniffFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("image");
    expect(sniffFileKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image");
  });
});

describe("resolveFileKind — extension + content, magic wins on mismatch", () => {
  it("a .txt whose bytes are actually a PDF routes to pdf", () => {
    expect(resolveFileKind("invoice.txt", Buffer.from("%PDF-1.4 ..."))).toBe("pdf");
  });

  it("a NO-extension file with text bytes reads as text", () => {
    expect(resolveFileKind("README", Buffer.from("just some notes"))).toBe("text");
  });

  it("a known text extension is trusted even with odd content", () => {
    expect(resolveFileKind("script.ts", Buffer.from("const x = 1;"))).toBe("text");
  });

  it("a .docx (a zip → sniffs unsupported) routes by extension", () => {
    expect(resolveFileKind("report.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe("docx");
  });

  it("an unknown extension with binary bytes stays unsupported", () => {
    expect(resolveFileKind("blob.dat", Buffer.from([0x00, 0xff, 0x00]))).toBe("unsupported");
  });
});
