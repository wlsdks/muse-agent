import { describe, expect, it } from "vitest";

import { pluralize } from "./pluralize.js";

describe("pluralize — singular only at exactly 1", () => {
  it("uses the singular for exactly 1", () => {
    expect(pluralize(1, "note")).toBe("note");
  });

  it("uses the regular plural for 0 and >1", () => {
    expect(pluralize(0, "note")).toBe("notes");
    expect(pluralize(16, "note")).toBe("notes");
  });

  it("honors an explicit irregular plural", () => {
    expect(pluralize(1, "entry", "entries")).toBe("entry");
    expect(pluralize(3, "entry", "entries")).toBe("entries");
  });
});
