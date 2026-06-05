import { describe, expect, it } from "vitest";

import {
  buildSurfaceForms,
  computeCooccurrence,
  mentionedContactIds,
  relatedByCooccurrence,
  relatedContactsByPmi
} from "./contact-cooccurrence.js";

const contacts = [
  { id: "sarah", name: "Sarah Kim" },
  { id: "tom", name: "Tom Lee", aliases: ["Tommy"] },
  { id: "mina", name: "Mina Park" },
  { id: "ubiq", name: "Pat Doe" } // appears everywhere — the "demote me" control
];

describe("buildSurfaceForms — name + alias + distinctive first name, ambiguous dropped", () => {
  it("includes full name, first name, and aliases", () => {
    const forms = buildSurfaceForms([{ id: "tom", name: "Tom Lee", aliases: ["Tommy"] }]);
    const padded = forms[0]!.forms;
    expect(padded).toContain(" tom lee ");
    expect(padded).toContain(" tom ");
    expect(padded).toContain(" tommy ");
  });

  it("drops an AMBIGUOUS first name shared by two contacts (keeps the full names)", () => {
    const forms = buildSurfaceForms([{ id: "a", name: "Sarah Kim" }, { id: "b", name: "Sarah Lee" }]);
    const all = forms.flatMap((s) => s.forms);
    expect(all).not.toContain(" sarah "); // ambiguous → dropped from both
    expect(all).toContain(" sarah kim ");
    expect(all).toContain(" sarah lee ");
  });
});

describe("mentionedContactIds — whole-word, case-insensitive, alias + first-name aware", () => {
  const surfaces = buildSurfaceForms(contacts);

  it("matches first name, full name, and alias; ignores substrings inside other words", () => {
    expect([...mentionedContactIds("Lunch with Sarah and Tommy today.", surfaces)].sort()).toEqual(["sarah", "tom"]);
    // "Minata" must NOT match contact "Mina" (whole-word only).
    expect(mentionedContactIds("The Minata festival was fun.", surfaces).has("mina")).toBe(false);
  });

  it("returns an empty set when no contact is named", () => {
    expect(mentionedContactIds("Bought groceries and cooked dinner.", surfaces).size).toBe(0);
  });
});

describe("relatedContactsByPmi / relatedByCooccurrence — meaningful association, not raw frequency", () => {
  // Pat (ubiq) appears in every note; Sarah & Tom share several specific notes.
  const notes = [
    "Met Sarah and Tom about the deck. Pat was there.",
    "Sarah and Tom reviewed the budget. Pat noted it.",
    "Sarah and Tom shipped the feature. Pat approved.",
    "Mina and Sarah grabbed coffee. Pat too.",
    "Pat sent the weekly update.",
    "Pat and Mina planned the offsite."
  ];

  it("ranks the specific co-mention (Tom) ABOVE the ubiquitous person (Pat) for Sarah, via PMI", () => {
    const related = relatedByCooccurrence({ contacts, noteBodies: notes, targetId: "sarah" });
    expect(related.length).toBeGreaterThanOrEqual(2);
    expect(related[0]!.id).toBe("tom"); // 3 shared notes, and rare-together → top PMI
    const tomPmi = related.find((r) => r.id === "tom")!.pmi;
    const patPmi = related.find((r) => r.id === "ubiq")?.pmi ?? -Infinity;
    expect(tomPmi).toBeGreaterThan(patPmi); // PMI demotes the everywhere-person
  });

  it("reports the shared-note count", () => {
    const related = relatedByCooccurrence({ contacts, noteBodies: notes, targetId: "sarah" });
    expect(related.find((r) => r.id === "tom")!.sharedNotes).toBe(3);
  });

  it("honours minShared (a single coincidental co-mention is filtered out)", () => {
    const onlyStrong = relatedByCooccurrence({ contacts, minShared: 2, noteBodies: notes, targetId: "sarah" });
    expect(onlyStrong.find((r) => r.id === "mina")).toBeUndefined(); // Sarah+Mina share only 1 note
    expect(onlyStrong.find((r) => r.id === "tom")).toBeDefined();
  });

  it("returns [] for an unmentioned target or an empty corpus", () => {
    const stats = computeCooccurrence([]);
    expect(relatedContactsByPmi(stats, "sarah")).toEqual([]);
    expect(relatedByCooccurrence({ contacts, noteBodies: ["nobody here"], targetId: "sarah" })).toEqual([]);
  });
});
