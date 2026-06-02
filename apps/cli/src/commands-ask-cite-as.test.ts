import { describe, expect, it } from "vitest";

import { stripEchoedCiteAs } from "./commands-ask.js";

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
