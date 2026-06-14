import { describe, expect, it } from "vitest";

import { createFindItemsTool, findAcrossDomains, type FindSources } from "../src/find-items-tool.js";

const SOURCES: FindSources = {
  tasks: [
    { id: "t1", title: "book dentist appointment" },
    { id: "t2", title: "buy milk" }
  ],
  reminders: [{ id: "r1", text: "call the dentist back" }],
  contacts: [{ id: "c1", name: "Dr. Kim", relationship: "dentist" }],
  events: [{ id: "e1", title: "team sync" }]
};

describe("findAcrossDomains (moved into @muse/autoconfigure)", () => {
  it("matches the query across every structured store, case-insensitive", () => {
    const hits = findAcrossDomains(SOURCES, "DENTIST");
    expect(hits.map((h) => h.domain).sort()).toEqual(["contact", "reminder", "task"]);
  });

  it("a blank query matches nothing (not everything)", () => {
    expect(findAcrossDomains(SOURCES, "   ")).toEqual([]);
  });
});

describe("createFindItemsTool", () => {
  it("is a read-risk tool named find_items", () => {
    const tool = createFindItemsTool({ find: () => SOURCES });
    expect(tool.definition.name).toBe("find_items");
    expect(tool.definition.risk).toBe("read");
  });

  it("returns the cross-store union of items mentioning the term (the chain the 12B can't do)", async () => {
    const tool = createFindItemsTool({ find: () => SOURCES });
    const result = (await tool.execute({ query: "dentist" }, { runId: "t", userId: "u" })) as {
      hits: { domain: string; label: string }[];
      total: number;
    };
    expect(result.total).toBe(3); // the dentist task + reminder + contact — NOT the milk task or team sync
    expect(result.hits.map((h) => h.domain).sort()).toEqual(["contact", "reminder", "task"]);
    expect(result.hits.some((h) => h.domain === "task" && h.label.toLowerCase().includes("dentist"))).toBe(true);
  });

  it("a blank/whitespace query returns zero hits, never the whole store", async () => {
    const tool = createFindItemsTool({ find: () => SOURCES });
    const result = (await tool.execute({ query: "   " }, { runId: "t", userId: "u" })) as { total: number };
    expect(result.total).toBe(0);
  });
});
