import { describe, expect, it } from "vitest";

import { findAcrossDomains } from "./commands-find.js";

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
    ]
  };

  it("matches across all three domains, case-insensitively", () => {
    const hits = findAcrossDomains(sources, "DENTIST");
    expect(hits.map((h) => `${h.domain}:${h.id}`)).toEqual(["task:t1", "reminder:r1", "contact:c1", "contact:c2"]);
  });

  it("surfaces the matched notes as context when the title didn't match", () => {
    const [hit] = findAcrossDomains({ tasks: [{ id: "t", title: "Errand", notes: "buy stamps" }] }, "stamps");
    expect(hit).toMatchObject({ domain: "task", label: "Errand", context: "buy stamps" });
  });

  it("matches a contact by email/handle/alias, not just name", () => {
    expect(findAcrossDomains(sources, "clinic.test").map((h) => h.id)).toEqual(["c1"]);
    expect(findAcrossDomains(sources, "dentist guy").map((h) => h.id)).toEqual(["c2"]);
  });

  it("returns nothing for a blank query or a no-match", () => {
    expect(findAcrossDomains(sources, "   ")).toEqual([]);
    expect(findAcrossDomains(sources, "zzzznope")).toEqual([]);
  });
});
