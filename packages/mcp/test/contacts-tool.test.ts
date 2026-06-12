import { describe, expect, it } from "vitest";

import { createContactsAddTool, createContactsFindTool, createContactsRemoveTool, type Contact } from "../src/index.js";

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
