import { describe, expect, it } from "vitest";

import {
  appendSystemSection,
  buildPersonaSnapshot,
  renderUserMemorySection,
  resolvePersonaSnapshot
} from "../src/runtime-helpers.js";

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

describe("buildPersonaSnapshot", () => {
  it("renders a key=value; key=value; … snapshot with fact./pref./topics segments", () => {
    const snapshot = buildPersonaSnapshot(
      {
        facts: { name: "Alice", role: "operator", extra: "ignored" },
        preferences: { tz: "Asia/Seoul", lang: "ko" },
        recentTopics: ["jarvis", "mcp", "agents", "extra-topic"],
        userId: "u-1"
      },
      2
    );
    expect(snapshot).toBeDefined();
    expect(snapshot).toContain("fact.name=Alice");
    expect(snapshot).toContain("fact.role=operator");
    // maxEntries=2 caps facts; "extra" must be dropped.
    expect(snapshot).not.toContain("ignored");
    expect(snapshot).toContain("pref.tz=Asia/Seoul");
    expect(snapshot).toContain("pref.lang=ko");
    // topics caps at 3 regardless of maxEntries.
    expect(snapshot).toContain("topics=jarvis,mcp,agents");
    expect(snapshot).not.toContain("extra-topic");
    // Single-line concat with `; `.
    expect(snapshot?.split("\n")).toHaveLength(1);
    expect(snapshot).toContain("; ");
  });

  it("returns undefined when the snapshot would be empty", () => {
    expect(
      buildPersonaSnapshot({ facts: {}, preferences: {}, userId: "u" }, 10)
    ).toBeUndefined();
  });
});

describe("resolvePersonaSnapshot", () => {
  it("returns undefined when no provider is configured", async () => {
    expect(
      await resolvePersonaSnapshot({ messages: [] }, undefined, 10)
    ).toBeUndefined();
  });

  it("returns undefined when metadata.userId is missing", async () => {
    expect(
      await resolvePersonaSnapshot(
        { messages: [], metadata: {} },
        { findByUserId: async () => ({ facts: { x: "y" }, preferences: {}, userId: "ghost" }) },
        10
      )
    ).toBeUndefined();
  });

  it("returns the rendered snapshot when provider + userId resolve to a memory", async () => {
    const snapshot = await resolvePersonaSnapshot(
      { messages: [], metadata: { userId: "alice" } },
      {
        findByUserId: async (id) => ({
          facts: { project: "muse" },
          preferences: { tone: "concise" },
          userId: id
        })
      },
      5
    );
    expect(snapshot).toContain("fact.project=muse");
    expect(snapshot).toContain("pref.tone=concise");
  });

  it("fails open: provider error → undefined (does not throw)", async () => {
    const snapshot = await resolvePersonaSnapshot(
      { messages: [], metadata: { userId: "alice" } },
      {
        findByUserId: async () => {
          throw new Error("provider exploded");
        }
      },
      5
    );
    expect(snapshot).toBeUndefined();
  });

  it("returns undefined when memory exists but is empty", async () => {
    const snapshot = await resolvePersonaSnapshot(
      { messages: [], metadata: { userId: "alice" } },
      {
        findByUserId: async (id) => ({ facts: {}, preferences: {}, userId: id })
      },
      5
    );
    expect(snapshot).toBeUndefined();
  });
});
