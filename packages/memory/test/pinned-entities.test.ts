import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../src/index.js";
import { extractPinnedEntities } from "../src/pinned-entities.js";

const m = (role: ConversationMessage["role"], content: string): ConversationMessage =>
  ({ content, role }) as ConversationMessage;

describe("extractPinnedEntities", () => {
  it("pins issue keys from user turns only (assistant output is ignored)", () => {
    expect(extractPinnedEntities([
      m("user", "Ship PROJ-1234 by Fri"),
      m("assistant", "ok ASSO-99 done"),
      m("system", "context CTX-1")
    ])).toEqual(["PROJ-1234"]);
  });

  it("requires a 2+ char alnum prefix before the dash (A-1 is not an issue key)", () => {
    expect(extractPinnedEntities([m("user", "compare A-1 and AB-1 builds")])).toEqual(["AB-1"]);
  });

  it("captures a Korean domain-noun phrase and a quoted term", () => {
    const out = extractPinnedEntities([
      m("user", 'fix the 결제 모듈 and the "q3 budget memo" please')
    ]);
    // The noun group is greedy across preceding words by design.
    expect(out).toContain("fix the 결제 모듈");
    expect(out).toContain("q3 budget memo");
  });

  it("dedupes the same entity across turns", () => {
    expect(extractPinnedEntities([
      m("user", "PROJ-1 again"),
      m("user", "still PROJ-1")
    ])).toEqual(["PROJ-1"]);
  });

  it("caps the result at 5 entities", () => {
    expect(extractPinnedEntities([m("user", "K1-1 K2-1 K3-1 K4-1 K5-1 K6-1 K7-1")]))
      .toEqual(["K1-1", "K2-1", "K3-1", "K4-1", "K5-1"]);
  });

  it("normalises internal whitespace in a quoted term", () => {
    expect(extractPinnedEntities([m("user", "note the 「  세금   공제  」 here")]))
      .toEqual(["세금 공제"]);
  });

  it("returns nothing for a turn with no anchor patterns", () => {
    expect(extractPinnedEntities([m("user", "thanks, that works great")])).toEqual([]);
  });
});
