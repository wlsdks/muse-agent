import { describe, expect, it } from "vitest";

import {
  filterNotesByScope,
  formatCoarseAge,
  formatNonNoteReceipts,
  formatSourceReceipts,
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

describe("formatSourceReceipts — disk-verified snippet (L4: receipt verifies the quote against the file ON DISK, not the index copy)", () => {
  const answer = "WireGuard uses 1420 MTU [from vpn.md].";
  const chunks = [{ file: "vpn.md", text: "WireGuard uses 1420 MTU on most links." }];

  // A snippet long enough that provenanceSnippet truncates it with a trailing `…`.
  // snippetOnDisk must strip that `…` and verify the CORE against disk — exercise
  // that path end-to-end (faithful shows the truncated quote, drift hides it).
  it("a TRUNCATED (…) snippet is disk-verified: shown when faithful, hidden on drift", () => {
    const longLine = "WireGuard uses a 1420 MTU on most links and this sentence is deliberately long enough to exceed ninety characters so it truncates here.";
    const ans = "MTU [from vpn.md].";
    const long = [{ file: "vpn.md", text: longLine }];
    const faithful = formatSourceReceipts(ans, "/n", long, "mtu", undefined, new Map([["vpn.md", longLine]])) ?? "";
    expect(faithful).toContain("…"); // the quote really IS truncated (so we're testing the … path)
    expect(faithful).toContain("WireGuard uses a 1420 MTU"); // verified core shown
    expect(faithful).not.toContain("changed since");
    const drifted = formatSourceReceipts(ans, "/n", long, "mtu", undefined, new Map([["vpn.md", "WireGuard now uses 1500 MTU after the rewrite."]])) ?? "";
    expect(drifted).not.toContain("WireGuard uses a 1420 MTU"); // stale truncated quote hidden
    expect(drifted).toContain("changed since");
  });

  it("no diskContents ⇒ snippet shown verbatim (backward-compatible, unchanged)", () => {
    const out = formatSourceReceipts(answer, "/notes", chunks, "wireguard mtu");
    expect(out).toContain('"WireGuard uses 1420 MTU on most links."');
  });

  it("disk content STILL contains the snippet ⇒ verified, snippet shown", () => {
    const disk = new Map([["vpn.md", "WireGuard uses 1420 MTU on most links."]]);
    const out = formatSourceReceipts(answer, "/notes", chunks, "wireguard mtu", undefined, disk);
    expect(out).toContain('"WireGuard uses 1420 MTU on most links."');
  });

  it("disk content DRIFTED (snippet no longer present) ⇒ snippet hidden, drift surfaced (not a fake citation)", () => {
    const disk = new Map([["vpn.md", "WireGuard now uses 1500 MTU after the rewrite."]]);
    const out = formatSourceReceipts(answer, "/notes", chunks, "wireguard mtu", undefined, disk) ?? "";
    expect(out).not.toContain('"WireGuard uses 1420 MTU on most links."');
    expect(out).toContain("changed since");
    expect(out).toContain("vpn.md"); // still cites the note, just won't vouch for the stale quote
  });

  it("disk content NULL (source deleted after indexing) ⇒ snippet hidden, absence surfaced", () => {
    const disk = new Map<string, string | null>([["vpn.md", null]]);
    const out = formatSourceReceipts(answer, "/notes", chunks, "wireguard mtu", undefined, disk) ?? "";
    expect(out).not.toContain('"WireGuard uses 1420 MTU on most links."');
    expect(out).toContain("no longer on disk");
  });

  it("no collateral: a faithful note in the same batch still shows its snippet while a drifted one is downgraded", () => {
    const ans = "MTU is 1420 [from vpn.md]. Cat's name is Mochi [from pets.md].";
    const twoChunks = [
      { file: "vpn.md", text: "WireGuard uses 1420 MTU on most links." },
      { file: "pets.md", text: "My cat is named Mochi." }
    ];
    const disk = new Map([
      ["vpn.md", "WireGuard now uses 1500 MTU after the rewrite."], // drifted
      ["pets.md", "My cat is named Mochi."] // faithful
    ]);
    const out = formatSourceReceipts(ans, "/notes", twoChunks, undefined, undefined, disk) ?? "";
    expect(out).toContain('"My cat is named Mochi."'); // faithful: shown
    expect(out).not.toContain('"WireGuard uses 1420 MTU on most links."'); // drifted: hidden
    expect(out).toContain("changed since");
  });
});

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
