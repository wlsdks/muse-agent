import { describe, expect, it } from "vitest";

import { CITATION_INSTRUCTION_LINES, stripEchoedCiteAs } from "./commands-ask.js";

describe("CITATION_INSTRUCTION_LINES — the recall answer-behaviour contract carries the conflict rule", () => {
  it("instructs the model to SURFACE conflicting evidence instead of silently picking one", () => {
    const joined = CITATION_INSTRUCTION_LINES.join("\n");
    expect(joined).toMatch(/CONFLICT/u);
    expect(joined).toMatch(/which is current/u); // the explicit conflict phrasing
    expect(joined).toMatch(/UPDATES the other|updates\/corrects/u); // the don't-over-flag-an-update carve-out
  });

  it("instructs the model NOT to claim it saved a fact (a one-shot ask can't persist) and to direct to `muse remember` / `muse chat`", () => {
    const joined = CITATION_INSTRUCTION_LINES.join("\n");
    expect(joined).toMatch(/SAVING|CANNOT persist|can't save/u);
    expect(joined).toMatch(/do NOT claim you saved|that would be a lie/u);
    expect(joined).toMatch(/muse remember/u);
    expect(joined).toMatch(/muse chat/u);
  });
});

describe("stripEchoedCiteAs — drop the echoed marker label, keep the citation", () => {
  it("strips a 'cite as:' the model echoed right before a real citation bracket", () => {
    expect(stripEchoedCiteAs("You set the MTU to 1380. cite as: [from vpn.md]")).toBe("You set the MTU to 1380. [from vpn.md]");
    expect(stripEchoedCiteAs("Rent is $1,450 cite as:[from finances.md]")).toBe("Rent is $1,450 [from finances.md]");
  });

  it("works for non-note citation classes too", () => {
    expect(stripEchoedCiteAs("Ship the deck. cite as: [task: ship the deck]")).toBe("Ship the deck. [task: ship the deck]");
    expect(stripEchoedCiteAs("Sarah. cite as: [contact: Sarah Chen]")).toBe("Sarah. [contact: Sarah Chen]");
  });

  it("leaves a clean citation untouched", () => {
    expect(stripEchoedCiteAs("You set the MTU to 1380 [from vpn.md].")).toBe("You set the MTU to 1380 [from vpn.md].");
  });

  it("does NOT strip 'cite as' in ordinary prose not preceding a citation bracket", () => {
    expect(stripEchoedCiteAs("I'll cite as needed.")).toBe("I'll cite as needed.");
    expect(stripEchoedCiteAs("do not cite as established fact")).toBe("do not cite as established fact");
  });
});
