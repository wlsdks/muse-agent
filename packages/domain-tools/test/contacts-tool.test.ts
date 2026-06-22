import { describe, expect, it } from "vitest";

import { createContactsAddTool, createContactsFindTool, createContactsRemoveTool, createUpcomingBirthdaysTool } from "../src/index.js";
import { type Contact } from "@muse/stores";

const PEOPLE: Contact[] = [
  { birthday: "12-25", email: "bob@acme.com", id: "c1", name: "Bob Acme" },
  { handle: "@jane", id: "c2", name: "Jane Doe" },
  { email: "bobby1@x.com", id: "c3", name: "Bobby One" },
  { email: "bobby2@x.com", id: "c4", name: "Bobby Two" },
  { id: "c5", name: "Mom", phone: "+1 415 555 0101" },
  { email: "sarah@x.com", id: "c6", name: "Sarah Chen", relationship: "manager" }
];

function tool(people: Contact[] = PEOPLE) {
  return createContactsFindTool({ contacts: () => people });
}

describe("createContactsFindTool — look up a person", () => {
  it("is risk:read and resolves an exact name to email/handle/birthday", async () => {
    expect(tool().definition.risk).toBe("read");
    expect(await tool().execute({ name: "Bob Acme" })).toMatchObject({ birthday: "12-25", email: "bob@acme.com", found: true, name: "Bob Acme" });
    expect(await tool().execute({ name: "Jane Doe" })).toMatchObject({ found: true, handle: "@jane" });
    // A contact without a birthday simply omits it.
    expect(await tool().execute({ name: "Jane Doe" })).not.toHaveProperty("birthday");
  });

  it("returns a contact's phone number when looked up by name ('what's mom's number?')", async () => {
    expect(await tool().execute({ name: "Mom" })).toMatchObject({ found: true, name: "Mom", phone: "+1 415 555 0101" });
  });

  it("surfaces the contact's RELATIONSHIP/role so the agent can answer 'who is Sarah?' / 'who's my manager?'", async () => {
    expect(await tool().execute({ name: "Sarah Chen" })).toMatchObject({ found: true, name: "Sarah Chen", relationship: "manager" });
    // A contact without a relationship simply omits it.
    expect(await tool().execute({ name: "Mom" })).not.toHaveProperty("relationship");
  });

  it("returns the candidates (never a guess) for an ambiguous name", async () => {
    const out = await tool().execute({ name: "Bobby" }) as { found: boolean; ambiguous?: boolean; candidates?: string[] };
    expect(out.found).toBe(false);
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toEqual(expect.arrayContaining(["Bobby One", "Bobby Two"]));
  });

  it("returns found:false for an unknown name and for an empty name (no guess)", async () => {
    expect(await tool().execute({ name: "Carol" })).toMatchObject({ found: false });
    expect(await tool().execute({ name: "  " })).toMatchObject({ found: false });
  });

  it("surfaces `about` (recall material) and `connections` so 'what do I know about Bob?' / 'what is Bob allergic to?' answers from the tool", async () => {
    const rich = createContactsFindTool({ contacts: () => [
      { about: "allergic to nuts; likes hiking", connections: [{ as: "works with", to: "Alice" }], email: "bob@r.com", id: "r1", name: "Bob Rich" }
    ] });
    const out = await rich.execute({ name: "Bob Rich" }) as { found: boolean; about?: string; connections?: { to: string; as?: string }[] };
    expect(out.found).toBe(true);
    expect(out.about).toBe("allergic to nuts; likes hiking");
    expect(out.connections).toEqual([{ as: "works with", to: "Alice" }]);
  });

  it("resolves by a reverse-lookup identifier — phone / email / @handle — not only a name (engine already supports it; lock it)", async () => {
    expect(await tool().execute({ name: "+1 415 555 0101" })).toMatchObject({ found: true, name: "Mom" });
    expect(await tool().execute({ name: "bob@acme.com" })).toMatchObject({ found: true, name: "Bob Acme" });
    expect(await tool().execute({ name: "@jane" })).toMatchObject({ found: true, name: "Jane Doe" });
  });
});

describe("createContactsAddTool — capture a person", () => {
  function addTool() {
    const saved: Contact[] = [];
    return { saved, tool: createContactsAddTool({ idFactory: () => "c-fixed", save: async (c) => { saved.push(c); } }) };
  }

  it("is risk:write and saves a contact with name + email (+ optional birthday)", async () => {
    const { saved, tool } = addTool();
    expect(tool.definition.risk).toBe("write");
    const out = await tool.execute({ birthday: "12-25", email: "bob@x.com", name: "Bob" });
    expect(out).toMatchObject({ added: true, name: "Bob" });
    expect(saved[0]).toMatchObject({ birthday: "12-25", email: "bob@x.com", id: "c-fixed", name: "Bob" });
  });

  it("saves a phone-only contact ('mom's number is …') — phone is a reachable channel", async () => {
    const { saved, tool } = addTool();
    const out = await tool.execute({ name: "Mom", phone: "415-555-0101" });
    expect(out).toMatchObject({ added: true, name: "Mom" });
    expect(saved[0]).toMatchObject({ id: "c-fixed", name: "Mom", phone: "415-555-0101" });
  });

  it("requires a name and at least one of email/handle/phone (never saves an unreachable contact)", async () => {
    const { saved, tool } = addTool();
    expect(await tool.execute({ name: "" })).toMatchObject({ added: false });
    expect(await tool.execute({ name: "Dave" })).toMatchObject({ added: false });
    expect(saved).toHaveLength(0);
  });

  it("rejects a malformed birthday", async () => {
    const { saved, tool } = addTool();
    expect(await tool.execute({ birthday: "Dec 25", email: "x@y.com", name: "X" })).toMatchObject({ added: false });
    expect(saved).toHaveLength(0);
  });

  it("captures the RELATIONSHIP/role when stated ('add Sarah, she's my manager') so 'who's my manager?' resolves later", async () => {
    const { saved, tool } = addTool();
    const out = await tool.execute({ email: "sarah@x.com", name: "Sarah Chen", relationship: "manager" });
    expect(out).toMatchObject({ added: true, name: "Sarah Chen", relationship: "manager" });
    expect(saved[0]).toMatchObject({ email: "sarah@x.com", id: "c-fixed", name: "Sarah Chen", relationship: "manager" });
  });

  it("omits relationship when not given (a plain contact stays plain)", async () => {
    const { saved, tool } = addTool();
    await tool.execute({ email: "x@y.com", name: "Plain" });
    expect(saved[0]).not.toHaveProperty("relationship");
  });

  it("declares relationship as groundedArgs so the runtime drops a fabricated role the user never stated", () => {
    const { tool } = addTool();
    expect((tool.definition as { groundedArgs?: readonly string[] }).groundedArgs).toContain("relationship");
  });
});

describe("createContactsAddTool — re-add of an existing name UPDATES in place (no duplicate)", () => {
  // A store mirroring the real `addContact`: id-idempotent (replace on a known id,
  // else append) — so the tool's name-match id-reuse REPLACES instead of duplicating.
  function idempotentStore() {
    const list: Contact[] = [];
    let n = 0;
    const tool = createContactsAddTool({
      contacts: () => list,
      idFactory: () => `c${(++n).toString()}`,
      save: async (c: Contact) => { const i = list.findIndex((x) => x.id === c.id); if (i >= 0) list[i] = c; else list.push(c); }
    });
    return { list, tool };
  }

  it("a second add for the same name reuses the id and merges fields (was a duplicate → ambiguous forever)", async () => {
    const { list, tool } = idempotentStore();
    const first = await tool.execute({ email: "bob@old.com", name: "Bob", phone: "415-555-0101" }) as { id: string; updated?: boolean };
    expect(list).toHaveLength(1);
    expect(first.updated).toBeUndefined();
    const second = await tool.execute({ email: "bob@new.com", name: "Bob" }) as { id: string; updated?: boolean };
    expect(list).toHaveLength(1); // STILL one Bob — not a duplicate
    expect(second.id).toBe(first.id); // existing id reused → the store REPLACES
    expect(second.updated).toBe(true);
    expect(list[0]!.email).toBe("bob@new.com"); // new value wins
    expect(list[0]!.phone).toBe("415-555-0101"); // unmentioned field preserved
  });

  it("an update preserves about / aliases / connections — the recall fields add_contact has no input for", async () => {
    const { list, tool } = idempotentStore();
    await tool.execute({ email: "bob@old.com", name: "Bob" });
    // Fields set via OTHER paths the tool can't take as args: `muse contacts add
    // --about/--alias` and `linkContacts`. `about` is grounding evidence + `aliases`
    // are resolution-critical, so an update-by-chat must not silently drop them.
    list[0] = { ...list[0]!, about: "allergic to nuts", aliases: ["Bobby"], connections: [{ as: "works with", to: "Alice" }] };
    await tool.execute({ email: "bob@new.com", name: "Bob" }); // update ONLY the email
    expect(list).toHaveLength(1);
    expect(list[0]!.email).toBe("bob@new.com");
    expect(list[0]!.about).toBe("allergic to nuts");
    expect(list[0]!.aliases).toEqual(["Bobby"]);
    expect(list[0]!.connections).toEqual([{ as: "works with", to: "Alice" }]);
  });

  it("matches the name case-insensitively", async () => {
    const { list, tool } = idempotentStore();
    await tool.execute({ email: "bob@x.com", name: "Bob" });
    await tool.execute({ name: "bob", phone: "555" });
    expect(list).toHaveLength(1);
    expect(list[0]!.email).toBe("bob@x.com");
    expect(list[0]!.phone).toBe("555");
  });

  it("without a contacts reader keeps the old new-id-each-time behavior (back-compat — the optional dep)", async () => {
    const list: Contact[] = [];
    let n = 0;
    const tool = createContactsAddTool({ idFactory: () => `c${(++n).toString()}`, save: async (c) => { list.push(c); } });
    await tool.execute({ email: "a@x.com", name: "Bob" });
    await tool.execute({ email: "b@x.com", name: "Bob" });
    expect(list).toHaveLength(2); // no reader → no dedup; the production seams pass the reader
  });
});

describe("createContactsRemoveTool — delete a person (fail-close)", () => {
  function removeTool(people: Contact[] = PEOPLE) {
    const removed: string[] = [];
    const present = [...people];
    return {
      removed,
      tool: createContactsRemoveTool({
        contacts: () => present,
        remove: async (id) => { removed.push(id); return present.some((c) => c.id === id); }
      })
    };
  }

  it("is risk:write and removes an exactly-resolved contact by id", async () => {
    const { removed, tool } = removeTool();
    expect(tool.definition.risk).toBe("write");
    expect(await tool.execute({ name: "Bob Acme" })).toMatchObject({ name: "Bob Acme", removed: true });
    expect(removed).toEqual(["c1"]);
  });

  it("an ambiguous name returns candidates and removes NOTHING (never a guess)", async () => {
    const { removed, tool } = removeTool();
    const out = await tool.execute({ name: "Bobby" }) as { removed: boolean; ambiguous?: boolean; candidates?: string[] };
    expect(out.removed).toBe(false);
    expect(out.ambiguous).toBe(true);
    expect(removed).toHaveLength(0);
  });

  it("an unknown / empty name removes nothing", async () => {
    const { removed, tool } = removeTool();
    expect(await tool.execute({ name: "Carol" })).toMatchObject({ removed: false });
    expect(await tool.execute({ name: " " })).toMatchObject({ removed: false });
    expect(removed).toHaveLength(0);
  });
});

describe("createUpcomingBirthdaysTool — list whose birthday is coming up", () => {
  // Pin "now" to 2026-12-20 so the window is deterministic: Zoe (12-22) is 2
  // days out, Bob (12-25) 5 days, Max (06-15) ~177 days. A contact with no
  // birthday is simply absent.
  const NOW = new Date(2026, 11, 20);
  const BDAY_PEOPLE: Contact[] = [
    { birthday: "12-25", id: "b1", name: "Bob Acme" },
    { birthday: "12-22", id: "b2", name: "Zoe Park" },
    { birthday: "06-15", id: "b3", name: "Max Far" },
    { id: "b4", name: "No Date" }
  ];
  function bdayTool(people: Contact[] = BDAY_PEOPLE) {
    return createUpcomingBirthdaysTool({ contacts: () => people, now: () => NOW });
  }

  it("is risk:read and lists only contacts within the window, soonest first (value flows through resolveUpcomingBirthdays)", async () => {
    const t = bdayTool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({ withinDays: 7 }) as { count: number; withinDays: number; upcoming: { name: string; daysUntil: number; date: string }[] };
    expect(out.withinDays).toBe(7);
    expect(out.count).toBe(2);
    expect(out.upcoming.map((u) => u.name)).toEqual(["Zoe Park", "Bob Acme"]);
    expect(out.upcoming[0]).toMatchObject({ name: "Zoe Park", daysUntil: 2, date: "12-22" });
    // The far birthday and the no-birthday contact never appear in a 7-day window.
    expect(out.upcoming.map((u) => u.name)).not.toContain("Max Far");
    expect(out.upcoming.map((u) => u.name)).not.toContain("No Date");
  });

  it("returns an empty list (count 0) when no contact has a birthday in range", async () => {
    const out = await bdayTool([{ id: "x", name: "Nobody" }]).execute({ withinDays: 7 }) as { count: number; upcoming: unknown[] };
    expect(out.count).toBe(0);
    expect(out.upcoming).toEqual([]);
  });

  it("defaults to a 30-day window when withinDays is omitted or out of range (never throws)", async () => {
    // omitted → 30: includes both December birthdays, still excludes June.
    const def = await bdayTool().execute({}) as { withinDays: number; upcoming: { name: string }[] };
    expect(def.withinDays).toBe(30);
    expect(def.upcoming.map((u) => u.name)).toEqual(["Zoe Park", "Bob Acme"]);
    // invalid (0) → clamps back to the 30-day default rather than an empty/NaN window.
    const zero = await bdayTool().execute({ withinDays: 0 }) as { withinDays: number };
    expect(zero.withinDays).toBe(30);
  });
});
