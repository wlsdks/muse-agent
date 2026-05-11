import { describe, expect, it } from "vitest";

import { sanitiseCitations } from "./citation-sanitiser.js";

describe("sanitiseCitations", () => {
  it("keeps https citations as-is", () => {
    const out = sanitiseCitations([{ url: "https://example.com", title: "Ex" }]);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it("keeps http citations", () => {
    const out = sanitiseCitations([{ url: "http://plain.test", title: "Plain" }]);
    expect(out.kept).toHaveLength(1);
  });

  it("drops javascript: URLs", () => {
    const out = sanitiseCitations([
      { url: "javascript:alert(1)", title: "evil" },
      { url: "https://safe.test", title: "safe" }
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]!.url).toBe("https://safe.test");
    expect(out.dropped).toBe(1);
  });

  it("drops data: URLs", () => {
    const out = sanitiseCitations([{ url: "data:text/html,<script/>", title: "x" }]);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("drops empty / whitespace-only URLs", () => {
    const out = sanitiseCitations([
      { url: "", title: "empty" },
      { url: "   ", title: "ws" }
    ]);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(2);
  });

  it("drops non-URL strings", () => {
    const out = sanitiseCitations([{ url: "not-a-url", title: "bad" }]);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("returns empty kept and zero dropped for empty input", () => {
    const out = sanitiseCitations([]);
    expect(out.kept).toEqual([]);
    expect(out.dropped).toBe(0);
  });
});
