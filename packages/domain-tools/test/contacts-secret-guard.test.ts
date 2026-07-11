import { describe, expect, it } from "vitest";

import { createContactsAddTool } from "../src/index.js";
import type { Contact } from "@muse/stores";

describe("add_contact — fail-close secret-persistence guard", () => {
  function addTool() {
    const saved: Contact[] = [];
    return { saved, tool: createContactsAddTool({ idFactory: () => "c-fixed", save: async (c) => { saved.push(c); } }) };
  }

  it("refuses a password-bearing relationship field and performs NO write", async () => {
    const { saved, tool } = addTool();
    const out = await tool.execute({ email: "bob@x.com", name: "Bob", relationship: "비밀번호는 hunter2" }) as {
      added?: boolean;
      blocked?: boolean;
      error?: string;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(out.kinds).toContain("credential-label");
    expect(saved).toHaveLength(0);
  });

  it("an ordinary relationship still saves normally (control — 'she's my dentist')", async () => {
    const { saved, tool } = addTool();
    const out = await tool.execute({ name: "Dr. Park", relationship: "dentist", phone: "415-555-0101" }) as { added?: boolean };
    expect(out.added).toBe(true);
    expect(saved[0]).toMatchObject({ name: "Dr. Park", relationship: "dentist" });
  });
});
