import { describe, expect, it } from "vitest";

import { groundingSectionLines, optionalGroundingRelevance, optionalGroundingSections, type OptionalGroundingSources } from "./present.js";

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
  it("emits ONLY the present sections, each with its header/footer label and present:true", () => {
    // With every section absent, no spec is emitted at all (no empty-block prompt bloat).
    expect(optionalGroundingSections(allAbsent)).toEqual([]);

    // A single present section round-trips its header + footer labels.
    const specs = optionalGroundingSections({ ...allAbsent, contacts: { body: "<c>", present: true } });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.header).toBe("=== MATCHING CONTACTS (from your address book) ===");
    expect(specs[0]?.footer).toBe("=== END CONTACTS ===");
    expect(specs[0]?.present).toBe(true);
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

  it("edge-places the highest-relevance present block at HEAD or TAIL, not the middle, and keeps the set invariant", () => {
    // reminders is a MIDDLE block by the old fixed array order (index 2 of the 5
    // present) but carries the HIGHEST relevance; tasks is the FIRST block by old
    // order but LOW relevance. Lost-in-the-middle: the highest-relevance block
    // must LEAVE the middle for an edge (head/tail).
    const present: OptionalGroundingSources = {
      ...allAbsent,
      tasks: { body: "TASKS", present: true, relevance: 0.01 },
      calendar: { body: "CAL", present: true, relevance: 0.2 },
      reminders: { body: "REM", present: true, relevance: 0.99 },
      contacts: { body: "CON", present: true, relevance: 0.4 },
      memories: { body: "MEM", present: true, relevance: 0.3 }
    };
    const specs = optionalGroundingSections(present);
    const headers = specs.map((s) => s.header);

    const remindersHeader = "=== PENDING REMINDERS (sorted by due date) ===";
    // (a) highest-relevance (reminders) lands at an EDGE of the optional region —
    // NOT its old middle slot. Goes RED under identity/fixed-order render.
    const remIdx = headers.indexOf(remindersHeader);
    expect(remIdx === 0 || remIdx === headers.length - 1).toBe(true);
    expect(remIdx).not.toBe(2);

    // (b) set-equality: every PRESENT block header appears exactly once, no ABSENT block leaks in.
    const presentHeaders = [
      "=== USER OPEN TASKS (sorted by due date, most imminent first) ===",
      "=== UPCOMING CALENDAR EVENTS (sorted chronologically) ===",
      remindersHeader,
      "=== MATCHING CONTACTS (from your address book) ===",
      "=== FACTS YOU TOLD MUSE TO REMEMBER (cite as [memory: <topic>]) ==="
    ];
    expect(specs).toHaveLength(presentHeaders.length);
    expect([...headers].sort()).toEqual([...presentHeaders].sort());
    for (const h of presentHeaders) {
      expect(headers.filter((x) => x === h)).toHaveLength(1);
    }
    // body still travels with its header (no cross-wiring during the reorder).
    expect(specs[remIdx]?.body).toBe("REM");
  });

  it("a HIGH per-turn recall score (via optionalGroundingRelevance) lifts a normally-mid-tier episodes block to an EDGE", () => {
    // PRODUCTION MIX: only episodes carries a per-turn relevance (commands-ask
    // scores episodes from episodeHits); the siblings pass NO relevance and so
    // exercise the real fallback path in optionalGroundingSections. episodes is a
    // LOW tier (40) — below actions(60)/git(55)/shell(50). With a strong recall
    // score blended in, episodes (0.675) must climb ABOVE the unscored siblings
    // and reach a head/tail slot. This only holds because the fallback for the
    // unscored siblings ALSO normalizes through optionalGroundingRelevance (same
    // 0-1 scale) — if the fallback used the raw tier (20-100), episodes' 0.675
    // would sink below every sibling: the exact scale-mix the fire-6 judge caught.
    const headerEpisodes = "=== PAST SESSION SUMMARIES (your prior conversations) ===";
    const present: OptionalGroundingSources = {
      ...allAbsent,
      actions: { body: "A", present: true },
      git: { body: "G", present: true },
      shell: { body: "S", present: true },
      // The 1-line mutation that flips this RED: replace 0.95 with `undefined` —
      // episodes then orders by its bare tier (40), sinking to a MIDDLE slot.
      // ALSO RED if present.ts's fallback reverts to the raw-tier `?? OPTIONAL_GROUNDING_TIER`
      // (the scale-mix bug): episodes 0.675 < raw siblings 50-60 → middle.
      episodes: { body: "E", present: true, relevance: optionalGroundingRelevance("episodes", 0.95) }
    };
    const specs = optionalGroundingSections(present);
    const headers = specs.map((s) => s.header);

    // (a) the high-scoring episodes block sits at an EDGE of the optional region.
    const epIdx = headers.indexOf(headerEpisodes);
    expect(epIdx === 0 || epIdx === headers.length - 1).toBe(true);

    // (b) set-equality: exactly the four present blocks, each once, none dropped/added.
    const presentHeaders = [
      "=== ACTIONS MUSE HAS TAKEN ON YOUR BEHALF (your audit log) ===",
      "=== YOUR RECENT GIT COMMITS (from this repo, newest first) ===",
      "=== MATCHING SHELL COMMANDS (from your shell history) ===",
      headerEpisodes
    ];
    expect(specs).toHaveLength(presentHeaders.length);
    expect([...headers].sort()).toEqual([...presentHeaders].sort());

    // (c) fabrication=0: each block's body travels byte-identical to its input.
    const bodyByHeader = new Map(specs.map((s) => [s.header, s.body]));
    expect(bodyByHeader.get(headerEpisodes)).toBe("E");
    expect(bodyByHeader.get("=== ACTIONS MUSE HAS TAKEN ON YOUR BEHALF (your audit log) ===")).toBe("A");
    expect(bodyByHeader.get("=== YOUR RECENT GIT COMMITS (from this repo, newest first) ===")).toBe("G");
    expect(bodyByHeader.get("=== MATCHING SHELL COMMANDS (from your shell history) ===")).toBe("S");
  });

  it("no-op safety: a score-less turn (helper undefined OR no relevance) renders BYTE-IDENTICAL to the bare tier-only order", () => {
    // Production must be a no-op for turns with no per-turn scores. The tier-only
    // order (no relevance anywhere) and the helper-with-undefined order must match
    // each other byte-for-byte — the helper's no-op path preserves tier ordering.
    const base = {
      ...allAbsent,
      tasks: { body: "T", present: true },
      git: { body: "G", present: true },
      episodes: { body: "E", present: true },
      reflection: { body: "R", present: true }
    };
    const tierOnly = optionalGroundingSections(base).map((s) => s.header);
    const helperUndefined = optionalGroundingSections({
      ...allAbsent,
      tasks: { body: "T", present: true, relevance: optionalGroundingRelevance("tasks", undefined) },
      git: { body: "G", present: true, relevance: optionalGroundingRelevance("git", undefined) },
      episodes: { body: "E", present: true, relevance: optionalGroundingRelevance("episodes", undefined) },
      reflection: { body: "R", present: true, relevance: optionalGroundingRelevance("reflection", undefined) }
    }).map((s) => s.header);
    expect(helperUndefined).toEqual(tierOnly);
  });

  it("falls back to a deterministic priority tier when relevance is absent (stable, no stochastic order)", () => {
    // No relevance scores anywhere — output must be deterministic and identical run-to-run.
    const present: OptionalGroundingSources = {
      ...allAbsent,
      tasks: { body: "T", present: true },
      calendar: { body: "C", present: true },
      memories: { body: "M", present: true }
    };
    const first = optionalGroundingSections(present).map((s) => s.header);
    const second = optionalGroundingSections(present).map((s) => s.header);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect([...first].sort()).toEqual([
      "=== FACTS YOU TOLD MUSE TO REMEMBER (cite as [memory: <topic>]) ===",
      "=== UPCOMING CALENDAR EVENTS (sorted chronologically) ===",
      "=== USER OPEN TASKS (sorted by due date, most imminent first) ==="
    ].sort());
  });
});

describe("optionalGroundingSections — content-free grounding header guard (doctrine P2/P4)", () => {
  it("drops a present:true block whose body is empty/whitespace (no content-free grounding header)", () => {
    // `present` is keyed off a match-COUNT at the callsite while `body` is rendered
    // separately — decoupled. A present:true block with an empty body would emit a
    // grounding header backing nothing. It must not be emitted; a present block WITH
    // real content still is. (No source lost — the dropped block has no content.)
    const specs = optionalGroundingSections({
      ...allAbsent,
      contacts: { body: "   \n  ", present: true },   // present but content-free
      tasks: { body: "<task 1>", present: true }       // present with real content
    });
    const headers = specs.map((s) => s.header);
    expect(headers).not.toContain("=== MATCHING CONTACTS (from your address book) ===");
    expect(headers).toContain("=== USER OPEN TASKS (sorted by due date, most imminent first) ===");
    expect(specs).toHaveLength(1);
  });
});
