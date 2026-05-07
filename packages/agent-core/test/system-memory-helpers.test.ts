import { describe, expect, it } from "vitest";

import { appendSystemSection, renderUserMemorySection } from "../src/runtime-helpers.js";

describe("renderUserMemorySection", () => {
  it("returns undefined when the snapshot has no facts, preferences, or recent topics", () => {
    expect(
      renderUserMemorySection({ facts: {}, preferences: {}, userId: "ghost" }, 5)
    ).toBeUndefined();
  });

  it("renders facts and preferences as bullet lists capped by maxEntries", () => {
    const block = renderUserMemorySection(
      {
        facts: { favorite_project: "muse", role: "operator", extra: "x", another: "y" },
        preferences: { tone: "concise", language: "en" },
        recentTopics: ["jarvis", "mcp", "agent-core"],
        userId: "operator-1"
      },
      2
    );
    expect(block).toBeDefined();
    expect(block).toContain("[User Memory]");
    expect(block).toContain("Known facts:");
    expect(block).toContain("- favorite_project: muse");
    expect(block).toContain("- role: operator");
    expect(block).not.toContain("extra: x");
    expect(block).toContain("Preferences:");
    expect(block).toContain("- tone: concise");
    expect(block).toContain("- language: en");
    expect(block).toContain("Recent topics: jarvis, mcp");
    expect(block).not.toContain("agent-core");
  });

  it("omits the preferences subsection when there are no preferences", () => {
    const block = renderUserMemorySection(
      { facts: { only: "fact" }, preferences: {}, userId: "u" },
      5
    );
    expect(block).toContain("Known facts:");
    expect(block).not.toContain("Preferences:");
  });
});

describe("appendSystemSection", () => {
  it("prepends a synthetic system message when no system message exists", () => {
    const result = appendSystemSection(
      [{ content: "hello", role: "user" }],
      "extra context",
      "ctx"
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ content: "<!-- muse:ctx -->\nextra context", role: "system" });
    expect(result[1]).toEqual({ content: "hello", role: "user" });
  });

  it("appends to the existing system message when one is present", () => {
    const result = appendSystemSection(
      [
        { content: "you are jarvis", role: "system" },
        { content: "hi", role: "user" }
      ],
      "section body",
      "context"
    );
    const system = result[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("you are jarvis");
    expect(system?.content).toContain("<!-- muse:context -->");
    expect(system?.content).toContain("section body");
  });

  it("replaces a previously-injected section instead of stacking duplicates", () => {
    const first = appendSystemSection(
      [{ content: "you are jarvis", role: "system" }],
      "v1",
      "context"
    );
    const second = appendSystemSection(first, "v2", "context");
    const system = second[0];
    expect(system?.content).toContain("v2");
    expect(system?.content).not.toContain("v1");
    // Marker only appears once.
    const markerCount = (system?.content.match(/muse:context/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it("uses the default sectionId='context' when none is supplied", () => {
    const result = appendSystemSection([], "a body");
    expect(result[0]?.content).toContain("<!-- muse:context -->");
  });
});
