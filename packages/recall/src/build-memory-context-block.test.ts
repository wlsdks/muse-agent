import { describe, expect, it } from "vitest";

import { buildMemoryContextBlock } from "./select.js";

describe("buildMemoryContextBlock — <<memory N>> grounding block", () => {
  it("empty list → the no-facts placeholder (no crash)", () => {
    expect(buildMemoryContextBlock([])).toBe("(no matching remembered facts)");
  });

  it("wraps each fact with its 1-based number, key, rendered value, and [memory: <key>] citation", () => {
    const block = buildMemoryContextBlock([
      { key: "wifi_password", value: "hunter2", kind: "fact" },
      { key: "allergic_to", value: "peanuts", kind: "fact" }
    ] as never);
    expect(block).toContain("<<memory 1 — wifi_password>>");
    expect(block).toContain("\nwifi password: hunter2\n[memory: wifi_password]\n<<end>>");
    expect(block).toContain("<<memory 2 — allergic_to>>");
    expect(block).toContain("[memory: allergic_to]");
    // citation embeds the KEY (the [memory: <topic>] hint), present for each
    expect(block).not.toContain("[memory: 1]");
  });

  it("separates multiple facts with a blank line", () => {
    const block = buildMemoryContextBlock([
      { key: "a", value: "1", kind: "fact" },
      { key: "b", value: "2", kind: "fact" }
    ] as never);
    expect(block).toContain("<<end>>\n\n<<memory 2");
  });
});
