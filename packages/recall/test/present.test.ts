import { describe, expect, it } from "vitest";

import {
  filterNotesByScope,
  formatCoarseAge,
  formatNonNoteReceipts,
  formatSourcesFooter,
  formatStalenessWarning,
  groundingSectionLines,
  provenanceDate,
  provenanceSnippet,
  recentFeedHeadlines,
  relativizeNoteSource,
  relevantSnippet
} from "@muse/recall";

const DAY = 86_400_000;

describe("provenanceSnippet", () => {
  it("collapses whitespace and keeps short text verbatim", () => {
    expect(provenanceSnippet("  hello   world \n line ")).toBe("hello world line");
  });
  it("truncates past max with an ellipsis", () => {
    expect(provenanceSnippet("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("relevantSnippet", () => {
  it("prefers the content line with the most query overlap over a heading", () => {
    const text = "# Network\nMTU is 1380 for the VPN tunnel\nunrelated trivia";
    expect(relevantSnippet(text, "what MTU for vpn")).toContain("MTU is 1380");
  });
  it("falls back to the first content line with no query", () => {
    expect(relevantSnippet("# Heading\nfirst line\nsecond", undefined)).toBe("first line");
  });
});

describe("provenanceDate", () => {
  it("extracts an ISO date from a note reference", () => {
    expect(provenanceDate("journal/2026-03-03.md")).toBe("2026-03-03");
  });
  it("returns undefined when absent", () => {
    expect(provenanceDate("projects/vpn.md")).toBeUndefined();
  });
});

describe("formatCoarseAge", () => {
  it("renders days, weeks, months, years", () => {
    expect(formatCoarseAge(3 * DAY)).toBe("3d ago");
    expect(formatCoarseAge(21 * DAY)).toBe("3w ago");
    expect(formatCoarseAge(90 * DAY)).toBe("3mo ago");
    expect(formatCoarseAge(400 * DAY)).toBe("1.1y ago");
  });

  it("drops the decimal once it is 2+ years (whole years read cleaner than '2.2y')", () => {
    expect(formatCoarseAge(800 * DAY)).toBe("2y ago"); // 2.19y → toFixed(0)
    expect(formatCoarseAge(1100 * DAY)).toBe("3y ago"); // 3.01y → toFixed(0)
  });
});

describe("formatStalenessWarning", () => {
  it("is empty when every cited note is fresh", () => {
    expect(formatStalenessWarning([{ note: "a.md", ageMs: DAY }], 30 * DAY)).toBe("");
  });
  it("names notes older than the threshold, most-stale first", () => {
    const out = formatStalenessWarning(
      [{ note: "old.md", ageMs: 100 * DAY }, { note: "older.md", ageMs: 400 * DAY }],
      30 * DAY
    );
    expect(out).toContain("older.md");
    expect(out.indexOf("older.md")).toBeLessThan(out.indexOf("old.md"));
  });
});

describe("relativizeNoteSource", () => {
  it("keeps an already-relative path", () => {
    expect(relativizeNoteSource("projects/vpn.md", "/home/me/notes")).toBe("projects/vpn.md");
  });
  it("relativizes an absolute path inside the notes dir", () => {
    expect(relativizeNoteSource("/home/me/notes/projects/vpn.md", "/home/me/notes")).toBe("projects/vpn.md");
  });
  it("falls back to the basename for a path that escapes the notes dir", () => {
    expect(relativizeNoteSource("/work/RUNBOOK.md", "/home/me/notes")).toBe("RUNBOOK.md");
  });
});

describe("filterNotesByScope", () => {
  const files = [{ path: "work/a.md" }, { path: "personal/b.md" }, { path: "work/sub/c.md" }];
  it("keeps only files under the scope prefix", () => {
    expect(filterNotesByScope(files, "/notes", "work").map((f) => f.path)).toEqual(["work/a.md", "work/sub/c.md"]);
  });
  it("returns everything for an empty scope", () => {
    expect(filterNotesByScope(files, "/notes", "  ")).toHaveLength(3);
  });
});

describe("groundingSectionLines", () => {
  it("omits sections with no content", () => {
    const lines = groundingSectionLines([
      { header: "H1", body: "B1", footer: "F1", present: true },
      { header: "H2", body: "B2", footer: "F2", present: false }
    ]);
    expect(lines).toEqual(["H1", "B1", "F1", ""]);
  });
});

describe("formatNonNoteReceipts", () => {
  it("renders one grouped line per cited non-note source", () => {
    const out = formatNonNoteReceipts("see [event: standup 9am] and [task: ship]", {
      events: ["standup 9am"],
      tasks: ["ship"]
    });
    expect(out).toContain("standup 9am");
    expect(out).toContain("ship");
  });
  it("is undefined when nothing was cited", () => {
    expect(formatNonNoteReceipts("plain answer", { events: ["x"] })).toBeUndefined();
  });
});

describe("formatSourcesFooter", () => {
  it("is undefined when the answer cites nothing", () => {
    expect(formatSourcesFooter("no citations here", "/notes")).toBeUndefined();
  });
  it("lists cited note paths", () => {
    const out = formatSourcesFooter("answer [from projects/vpn.md]", "/home/me/notes");
    expect(out).toContain("/home/me/notes/projects/vpn.md");
  });
});

describe("recentFeedHeadlines", () => {
  it("returns newest-first across feeds, capped at the limit", () => {
    const feeds = [
      { name: "f1", entries: [{ title: "old", publishedAt: "2026-01-01", summary: "" }] },
      { name: "f2", entries: [{ title: "new", publishedAt: "2026-06-01", summary: "" }] }
    ];
    const out = recentFeedHeadlines(feeds, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("new");
  });
  it("returns nothing for a non-positive limit", () => {
    expect(recentFeedHeadlines([], 0)).toEqual([]);
  });
});
