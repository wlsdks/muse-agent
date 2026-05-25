import { describe, expect, it } from "vitest";

import { dailyInboxNotePath, formatCaptureLine } from "./commands-note.js";

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
