import { describe, expect, it } from "vitest";

import { formatNonNoteReceipts } from "./commands-ask.js";

describe("formatNonNoteReceipts — felt 'shows its work' for non-note sources (S1)", () => {
  it("renders one grounded line per cited non-note source, grouped", () => {
    const answer = "Your board review is June 3rd [event: Quarterly board review]; pay rent [task: Pay Q3 rent]; Sarah is sarah@x.com [contact: Sarah Chen].";
    const out = formatNonNoteReceipts(answer, {
      contacts: ["Sarah Chen"],
      events: ["Quarterly board review"],
      tasks: ["Pay Q3 rent"]
    });
    expect(out).toContain("📎 Also grounded on:");
    expect(out).toContain("📅 from your calendar: Quarterly board review");
    expect(out).toContain("✅ from your tasks: Pay Q3 rent");
    expect(out).toContain("👤 from your contacts: Sarah Chen");
  });

  it("renders a shell-command receipt", () => {
    const out = formatNonNoteReceipts("Run [command: docker run nginx].", { commands: ["docker run -p 8080:80 nginx"] });
    expect(out).toContain("⌨️ from your shell history: docker run nginx");
  });

  it("renders a feed receipt so a 'what's new in <feed>?' answer is followable", () => {
    const out = formatNonNoteReceipts("Top story [feed: HN].", { feeds: ["HN", "Lobsters"] });
    expect(out).toContain("📰 from your feeds: HN");
  });

  it("skips a source type that has nothing configured this turn", () => {
    // the answer cites an event, but no events were grounded → no receipt for it
    expect(formatNonNoteReceipts("see [event: ghost meeting].", { events: [] })).toBeUndefined();
  });

  it("returns undefined when the answer cites nothing (e.g. a refusal)", () => {
    expect(formatNonNoteReceipts("I'm not sure — nothing covers that.", { tasks: ["Pay rent"], events: ["X"] })).toBeUndefined();
  });

  it("de-duplicates a source cited twice", () => {
    const out = formatNonNoteReceipts("[task: pay rent] and again [task: pay rent].", { tasks: ["Pay Q3 rent"] }) ?? "";
    expect(out.match(/from your tasks:/gu)?.length).toBe(1);
  });
});
