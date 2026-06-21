import { describe, expect, it } from "vitest";

import { rankCommands } from "./commandFilter.js";

const cmds = [
  { id: "a", title: "Open tasks", group: "Navigate" },
  { id: "b", title: "Tasks", group: "Navigate" },
  { id: "c", title: "Settings", group: "System" },
  { id: "d", title: "Calendar", group: "Workspace" }
];

const titles = (q: string) => rankCommands(cmds, q).map((c) => c.title);

describe("rankCommands", () => {
  it("returns all commands unchanged for an empty query", () => {
    expect(titles("")).toEqual(["Open tasks", "Tasks", "Settings", "Calendar"]);
    expect(titles("   ")).toEqual(["Open tasks", "Tasks", "Settings", "Calendar"]);
  });

  it("filters to substring matches", () => {
    expect(titles("cal")).toEqual(["Calendar"]);
  });

  it("ranks a title prefix above a mid-string match", () => {
    // "Tasks" starts with "tas" (100) > "Open tasks" merely contains it (60)
    expect(titles("tas")).toEqual(["Tasks", "Open tasks"]);
  });

  it("matches a fuzzy subsequence", () => {
    expect(titles("stng")).toEqual(["Settings"]);
  });

  it("requires every space-separated term to match (AND)", () => {
    expect(titles("open task")).toEqual(["Open tasks"]);
    expect(titles("open zzz")).toEqual([]);
  });

  it("matches by group name too", () => {
    expect(rankCommands(cmds, "system").map((c) => c.id)).toEqual(["c"]);
  });

  it("returns empty when nothing matches", () => {
    expect(titles("zzzzz")).toEqual([]);
  });
});
