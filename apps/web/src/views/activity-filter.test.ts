import { describe, expect, it } from "vitest";

import { ACTIVITY_FILTER_KINDS, historyQueryPath } from "./Activity.js";

describe("historyQueryPath — GET /api/history URL for a filter selection", () => {
  it("omits the kind param for 'all'", () => {
    expect(historyQueryPath("all")).toBe("/api/history?limit=25");
  });

  it("adds a URL-encoded kind param for each real kind", () => {
    for (const kind of ACTIVITY_FILTER_KINDS) {
      expect(historyQueryPath(kind)).toBe(`/api/history?limit=25&kind=${kind}`);
    }
  });

  it("URL-encodes a kind value that needs it", () => {
    expect(historyQueryPath("weird kind")).toBe("/api/history?limit=25&kind=weird%20kind");
  });
});
