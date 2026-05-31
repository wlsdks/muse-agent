import type { WebSearchCitation } from "@muse/model";
import { describe, expect, it } from "vitest";

import { sanitiseCitations } from "../src/citation-sanitiser.js";

const cite = (url: string): WebSearchCitation => ({ title: "t", url });

describe("sanitiseCitations — only safe http(s) citation links reach the user", () => {
  it("keeps http and https citations, in order", () => {
    const result = sanitiseCitations([cite("https://a.example"), cite("http://b.example")]);
    expect(result.kept.map((c) => c.url)).toEqual(["https://a.example", "http://b.example"]);
    expect(result.dropped).toBe(0);
  });

  it("DROPS dangerous / non-web protocols (javascript:, data:, file:, ftp:, mailto:)", () => {
    const bad = ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "ftp://host/x", "mailto:a@b.c"];
    const result = sanitiseCitations(bad.map(cite));
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(bad.length);
  });

  it("DROPS empty, whitespace-only, malformed, or non-string URLs without throwing", () => {
    const result = sanitiseCitations([
      cite(""),
      cite("   "),
      cite("not a url"),
      { title: "t", url: 123 as unknown as string }
    ]);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(4);
  });

  it("partitions a mixed list and reports the exact dropped count, preserving the kept order", () => {
    const result = sanitiseCitations([
      cite("https://keep1.example"),
      cite("javascript:evil"),
      cite("http://keep2.example"),
      cite("data:bad"),
      cite("https://keep3.example")
    ]);
    expect(result.kept.map((c) => c.url)).toEqual(["https://keep1.example", "http://keep2.example", "https://keep3.example"]);
    expect(result.dropped).toBe(2);
  });

  it("returns an empty result for no citations", () => {
    expect(sanitiseCitations([])).toEqual({ dropped: 0, kept: [] });
  });
});
