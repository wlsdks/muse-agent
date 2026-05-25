import { describe, expect, it } from "vitest";

import { dailyInboxNotePath, formatCaptureLine, selectConnections } from "./commands-note.js";

describe("selectConnections — SB-3: proactively connect a fresh capture to past knowledge", () => {
  const hits = [
    { ref: "inbox/2026-05-25.md", score: 0.99, snippet: "the just-captured line", source: "notes" as const },
    { ref: "projects/ssl.md", score: 0.72, snippet: "renew prod certs every quarter", source: "notes" as const },
    { ref: "ep1", score: 0.55, snippet: "discussed TLS rotation", source: "episodes" as const },
    { ref: "random.md", score: 0.2, snippet: "unrelated grocery note", source: "notes" as const }
  ];
  it("excludes the self note, drops below-threshold, returns top-N prior matches", () => {
    const out = selectConnections(hits, "inbox/2026-05-25.md", 0.5, 2);
    expect(out.map((h) => h.ref)).toEqual(["projects/ssl.md", "ep1"]);
  });
  it("returns nothing when only the self note matches", () => {
    expect(selectConnections([hits[0]!], "inbox/2026-05-25.md", 0.5, 2)).toEqual([]);
  });
});

describe("dailyInboxNotePath — frictionless capture auto-routes to a daily inbox note", () => {
  it("routes to inbox/YYYY-MM-DD.md by the local date", () => {
    expect(dailyInboxNotePath(new Date("2026-05-25T14:03:00.000Z"))).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}\.md$/);
  });
});

describe("formatCaptureLine — one timestamped bullet per captured thought", () => {
  it("prefixes a local HH:MM timestamp bullet and trims the text", () => {
    const line = formatCaptureLine("  buy milk  ", new Date("2026-05-25T14:03:00.000Z"));
    expect(line).toMatch(/^- \d{2}:\d{2} buy milk$/);
  });
  it("collapses internal newlines so one capture stays one bullet", () => {
    expect(formatCaptureLine("a\nb", new Date("2026-05-25T14:03:00.000Z"))).toMatch(/^- \d{2}:\d{2} a b$/);
  });
});
