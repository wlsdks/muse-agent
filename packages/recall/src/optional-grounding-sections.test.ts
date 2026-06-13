import { describe, expect, it } from "vitest";

import { groundingSectionLines, optionalGroundingSections, type OptionalGroundingSources } from "./present.js";

const allAbsent: OptionalGroundingSources = {
  tasks: { body: "", present: false },
  calendar: { body: "", present: false },
  reminders: { body: "", present: false },
  contacts: { body: "", present: false },
  memories: { body: "", present: false },
  shell: { body: "", present: false },
  git: { body: "", present: false },
  actions: { body: "", present: false },
  episodes: { body: "", present: false },
  feeds: { body: "", present: false },
  reflection: { body: "", present: false }
};

describe("optionalGroundingSections", () => {
  it("emits all 11 sections in a fixed render order with their labels", () => {
    const specs = optionalGroundingSections(allAbsent);
    expect(specs.map((s) => s.header)).toEqual([
      "=== USER OPEN TASKS (sorted by due date, most imminent first) ===",
      "=== UPCOMING CALENDAR EVENTS (sorted chronologically) ===",
      "=== PENDING REMINDERS (sorted by due date) ===",
      "=== MATCHING CONTACTS (from your address book) ===",
      "=== FACTS YOU TOLD MUSE TO REMEMBER (cite as [memory: <topic>]) ===",
      "=== MATCHING SHELL COMMANDS (from your shell history) ===",
      "=== YOUR RECENT GIT COMMITS (from this repo, newest first) ===",
      "=== ACTIONS MUSE HAS TAKEN ON YOUR BEHALF (your audit log) ===",
      "=== PAST SESSION SUMMARIES (your prior conversations) ===",
      "=== RECENT FEED HEADLINES (your watched RSS/Atom feeds, newest first) ===",
      "=== WHAT MUSE HAS NOTICED ABOUT YOU (high-level, from past sessions) ==="
    ]);
    expect(specs.map((s) => s.footer)).toEqual([
      "=== END TASKS ===", "=== END CALENDAR ===", "=== END REMINDERS ===", "=== END CONTACTS ===",
      "=== END REMEMBERED FACTS ===", "=== END SHELL COMMANDS ===", "=== END GIT COMMITS ===",
      "=== END ACTIONS ===", "=== END PAST SESSIONS ===", "=== END FEED HEADLINES ===", "=== END NOTICED ==="
    ]);
  });

  it("carries each source's body + present through to the matching spec", () => {
    const specs = optionalGroundingSections({ ...allAbsent, tasks: { body: "<task 1>", present: true } });
    expect(specs[0]?.body).toBe("<task 1>");
    expect(specs[0]?.present).toBe(true);
  });

  it("groundingSectionLines drops absent sections and renders present ones in order", () => {
    const lines = groundingSectionLines(
      optionalGroundingSections({
        ...allAbsent,
        tasks: { body: "T", present: true },
        feeds: { body: "F", present: true }
      })
    );
    // only tasks + feeds survive, each as header/body/footer/"" — tasks before feeds
    expect(lines).toEqual([
      "=== USER OPEN TASKS (sorted by due date, most imminent first) ===", "T", "=== END TASKS ===", "",
      "=== RECENT FEED HEADLINES (your watched RSS/Atom feeds, newest first) ===", "F", "=== END FEED HEADLINES ===", ""
    ]);
  });

  it("an all-absent input yields zero rendered lines (no empty-block prompt bloat)", () => {
    expect(groundingSectionLines(optionalGroundingSections(allAbsent))).toEqual([]);
  });
});
