import { describe, expect, it } from "vitest";

import { looksLikeBinaryContent, selectFilePassages, urlGroundingSource } from "./commands-ask.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("urlGroundingSource — the cite label for a --url-grounded answer", () => {
  it("uses the host (www. stripped) so the answer cites [from <host>]", () => {
    expect(urlGroundingSource("https://example.com/page")).toBe("example.com");
    expect(urlGroundingSource("https://www.nytimes.com/2026/article")).toBe("nytimes.com");
    expect(urlGroundingSource("http://blog.example.org/")).toBe("blog.example.org");
  });

  it("falls back to the raw string for an unparseable URL", () => {
    expect(urlGroundingSource("not a url")).toBe("not a url");
  });
});

describe("looksLikeBinaryContent — refuse to ground on a binary --file (no hallucinated content)", () => {
  it("flags a buffer with a NUL byte as binary (the canonical text-vs-binary signal)", () => {
    expect(looksLikeBinaryContent(new Uint8Array([0x48, 0x69, 0x00, 0x21]))).toBe(true);
  });

  it("flags a real-shaped PDF (magic header + binary stream bytes) as binary", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe]);
    expect(looksLikeBinaryContent(pdf)).toBe(true);
  });

  it("flags a run of invalid UTF-8 (high replacement-char ratio) as binary", () => {
    expect(looksLikeBinaryContent(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xc0, 0xc1, 0xf5, 0xf6, 0xf7, 0xf8]))).toBe(true);
  });

  it("treats plain ASCII text as NOT binary", () => {
    expect(looksLikeBinaryContent(bytes("Job title: Staff Data Scientist at Acme.\n"))).toBe(false);
  });

  it("treats valid UTF-8 (Korean + emoji) as NOT binary", () => {
    expect(looksLikeBinaryContent(bytes("내 차 번호판은 12가 3456 🚗 입니다.\n"))).toBe(false);
  });

  it("treats an empty file as NOT binary (nothing to misread)", () => {
    expect(looksLikeBinaryContent(new Uint8Array([]))).toBe(false);
  });
});

describe("selectFilePassages — ad-hoc --file grounding", () => {
  it("returns every passage of a small file, in original order", () => {
    const picked = selectFilePassages("The VPN MTU is 1380.\n\nThe office is at 5th Ave.", "what is the mtu");
    expect(picked.length).toBeGreaterThanOrEqual(1);
    expect(picked.map((p) => p.chunkIndex)).toEqual([...picked.map((p) => p.chunkIndex)].sort((a, b) => a - b));
    expect(picked.some((p) => p.text.includes("1380"))).toBe(true);
  });

  it("ranks the query-relevant passage in, and respects the char budget for a big file", () => {
    const big = Array.from({ length: 50 }, (_u, i) => `Section ${i.toString()}: filler about topic ${i.toString()}.`).join("\n\n")
      + "\n\nThe secret port number is 8443.";
    const picked = selectFilePassages(big, "what is the secret port number", 400);
    const total = picked.reduce((n, p) => n + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(400 + 1200); // budget + at most one overflowing passage
    expect(picked.some((p) => p.text.includes("8443"))).toBe(true); // the relevant passage made the cut
  });

  it("an empty file yields no passages", () => {
    expect(selectFilePassages("", "anything")).toEqual([]);
    expect(selectFilePassages("   \n  ", "anything")).toEqual([]);
  });
});
