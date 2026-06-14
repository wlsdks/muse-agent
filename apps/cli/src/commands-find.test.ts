import { describe, expect, it } from "vitest";

import { findAcrossDomains } from "@muse/autoconfigure";

import { formatNoMatches } from "./commands-find.js";

describe("formatNoMatches — empty state names every searched domain", () => {
  it("names tasks, reminders, contacts, AND calendar (matches the command's scope)", () => {
    const msg = formatNoMatches("conference");
    expect(msg).toContain('"conference"');
    expect(msg.toLowerCase()).toContain("tasks");
    expect(msg.toLowerCase()).toContain("reminders");
    expect(msg.toLowerCase()).toContain("contacts");
    expect(msg.toLowerCase()).toContain("calendar");
  });
});

describe("findAcrossDomains — substring across tasks/reminders/contacts", () => {
  const sources = {
    tasks: [
      { id: "t1", title: "Call dentist", notes: "ring the office" },
      { id: "t2", title: "Buy milk" }
    ],
    reminders: [{ id: "r1", text: "Dentist appointment Tuesday" }, { id: "r2", text: "Standup" }],
    contacts: [
      { id: "c1", name: "Dr. Dentist", email: "doc@clinic.test" },
      { id: "c2", name: "Bob", aliases: ["dentist guy"] },
      { id: "c3", name: "Alice" }
    ],
    events: [
      { id: "ev1", title: "Dentist checkup", notes: "bring insurance card" },
      { id: "ev2", title: "Team sync" }
    ]
  };

  it("matches across all four domains, case-insensitively", () => {
    const hits = findAcrossDomains(sources, "DENTIST");
    expect(hits.map((h) => `${h.domain}:${h.id}`)).toEqual(["task:t1", "reminder:r1", "contact:c1", "contact:c2", "event:ev1"]);
  });

  it("surfaces the matched notes as context when the title didn't match", () => {
    const [hit] = findAcrossDomains({ tasks: [{ id: "t", title: "Errand", notes: "buy stamps" }] }, "stamps");
    expect(hit).toMatchObject({ domain: "task", label: "Errand", context: "buy stamps" });
  });

  it("matches a contact by email/handle/alias, not just name", () => {
    expect(findAcrossDomains(sources, "clinic.test").map((h) => h.id)).toEqual(["c1"]);
    expect(findAcrossDomains(sources, "dentist guy").map((h) => h.id)).toEqual(["c2"]);
  });

  it("matches a contact by RELATIONSHIP and free-text ABOUT, with WHY as context", () => {
    const people = {
      contacts: [
        { id: "m", name: "Dana Wu", relationship: "manager" },
        { id: "f", name: "Sam", about: "loves hiking and climbing" }
      ]
    };
    // find by role
    expect(findAcrossDomains(people, "manager")).toEqual([{ domain: "contact", id: "m", label: "Dana Wu", context: "your manager" }]);
    // find by something you know about them
    expect(findAcrossDomains(people, "hiking")).toEqual([{ domain: "contact", id: "f", label: "Sam", context: "loves hiking and climbing" }]);
    // a NAME match still wins with no redundant context
    expect(findAcrossDomains(people, "dana")).toEqual([{ domain: "contact", id: "m", label: "Dana Wu" }]);
  });

  it("returns nothing for a blank query or a no-match", () => {
    expect(findAcrossDomains(sources, "   ")).toEqual([]);
    expect(findAcrossDomains(sources, "zzzznope")).toEqual([]);
  });
});
