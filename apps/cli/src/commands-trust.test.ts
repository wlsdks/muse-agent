import { describe, expect, it } from "vitest";

import { groupToolsByDomain } from "./commands-trust.js";

describe("groupToolsByDomain", () => {
  it("groups tools by the segment before their first dot", () => {
    expect(groupToolsByDomain(["muse.notes.search", "muse.notes.list", "muse.tasks.add"])).toEqual({
      muse: ["muse.notes.search", "muse.notes.list", "muse.tasks.add"]
    });
  });

  it("buckets dotless tool names under '(unscoped)'", () => {
    expect(groupToolsByDomain(["home_state", "muse.time.now"])).toEqual({
      "(unscoped)": ["home_state"],
      muse: ["muse.time.now"]
    });
  });

  it("returns an empty object for no tools", () => {
    expect(groupToolsByDomain([])).toEqual({});
  });
});
