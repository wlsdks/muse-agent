import { describe, expect, it } from "vitest";

import type { Contact } from "@muse/stores";

import { contactGroundingEvidence, contactMatchScore } from "./commands-ask.js";

const tokens = (q: string): Set<string> => {
  // mirror lexicalTokens loosely for the test — split on non-word, drop short
  return new Set(q.toLowerCase().split(/[^a-z0-9]+/u).filter((t) => t.length > 1));
};

const sarah: Contact = { id: "c1", name: "Sarah Chen", email: "sarah@example.com", phone: "+1 415 555 0101", aliases: ["Sare"] };
const plumber: Contact = { id: "c2", name: "Mike Reynolds", handle: "@mikeplumbing" };

describe("contactMatchScore — query→contact relevance for muse ask grounding (B3)", () => {
  it("matches on the first name a question uses", () => {
    expect(contactMatchScore(sarah, tokens("what is sarah's email"))).toBeGreaterThan(0);
  });

  it("matches on an alias and on a handle", () => {
    expect(contactMatchScore(sarah, tokens("how do I reach sare"))).toBeGreaterThan(0);
    expect(contactMatchScore(plumber, tokens("ping mikeplumbing about the leak"))).toBeGreaterThan(0);
  });

  it("scores 0 for an unrelated question (so the contact is NOT injected → honest refusal)", () => {
    expect(contactMatchScore(sarah, tokens("when is my dentist appointment"))).toBe(0);
    expect(contactMatchScore(plumber, tokens("what is the wifi password"))).toBe(0);
  });

  it("scores 0 for an empty query", () => {
    expect(contactMatchScore(sarah, new Set())).toBe(0);
  });

  it("a more-specific question (full name) scores higher than a partial", () => {
    expect(contactMatchScore(sarah, tokens("email sarah chen"))).toBeGreaterThan(contactMatchScore(sarah, tokens("email sarah")));
  });

  it("matches on the RELATIONSHIP so 'who is my manager?' surfaces the right contact", () => {
    const boss: Contact = { id: "c3", name: "Dana Wu", email: "dana@example.com", relationship: "manager" };
    expect(contactMatchScore(boss, tokens("who is my manager"))).toBeGreaterThan(0);
    // a contact with no relationship doesn't get falsely surfaced by the role query
    expect(contactMatchScore(sarah, tokens("who is my manager"))).toBe(0);
  });

  it("matches on the free-text ABOUT so a question about a remembered fact surfaces the contact", () => {
    const bob: Contact = { id: "c4", name: "Bob", email: "bob@x.com", about: "allergic to nuts, loves hiking" };
    expect(contactMatchScore(bob, tokens("is bob allergic to anything"))).toBeGreaterThan(0);
    expect(contactMatchScore(bob, tokens("who likes hiking"))).toBeGreaterThan(0);
    // an unrelated query still scores 0 — the about field doesn't over-match
    expect(contactMatchScore(sarah, tokens("who likes hiking"))).toBe(0);
  });
});

import { formatContactBirthday } from "./commands-ask.js";

describe("formatContactBirthday — readable birthday for contacts grounding", () => {
  it("formats MM-DD as 'Month Day'", () => {
    expect(formatContactBirthday("03-14")).toBe("March 14");
    expect(formatContactBirthday("12-01")).toBe("December 1");
  });

  it("appends the year when present (YYYY-MM-DD)", () => {
    expect(formatContactBirthday("1990-03-14")).toBe("March 14, 1990");
  });

  it("returns undefined for absent / malformed / out-of-range values (no fabricated date)", () => {
    expect(formatContactBirthday(undefined)).toBeUndefined();
    expect(formatContactBirthday("")).toBeUndefined();
    expect(formatContactBirthday("not-a-date")).toBeUndefined();
    expect(formatContactBirthday("13-40")).toBeUndefined();
  });
});

describe("contactGroundingEvidence — the grounding evidence mirrors the prompt block (no false 'unverified')", () => {
  it("INCLUDES the relationship/role so 'your manager is Dana' is covered, not false-flagged", () => {
    const dana: Contact = { id: "c_d", name: "Dana Wu", email: "dana@example.com", relationship: "manager" };
    const evidence = contactGroundingEvidence(dana);
    expect(evidence).toContain("Dana Wu");
    expect(evidence).toContain("manager"); // the claim "your manager is Dana" is now covered by the evidence
    expect(evidence).toContain("dana@example.com");
  });

  it("INCLUDES connections/edges so 'Bob works with Alice' is covered", () => {
    const bob: Contact = { id: "c_b", name: "Bob", email: "bob@x.com", connections: [{ to: "Alice", as: "works with" }] };
    const evidence = contactGroundingEvidence(bob);
    expect(evidence).toContain("works with Alice"); // the edge claim is in the evidence
  });

  it("only adds REAL data — a contact with no role/edges yields just name + reach fields (a fabricated edge stays uncovered)", () => {
    const flat: Contact = { id: "c_f", name: "Sam", handle: "@sam" };
    expect(contactGroundingEvidence(flat)).toBe("Sam @sam");
  });

  it("a bare edge (no `as` relation) is rendered as 'connected to <name>'", () => {
    const c: Contact = { id: "c_x", name: "Pat", connections: [{ to: "Jo" }] };
    expect(contactGroundingEvidence(c)).toContain("connected to Jo");
  });

  it("INCLUDES the free-text `about` so a remembered fact is covered, not false-flagged as unverified", () => {
    const bob: Contact = { id: "c_b2", name: "Bob", email: "bob@x.com", about: "allergic to nuts" };
    const evidence = contactGroundingEvidence(bob);
    expect(evidence).toContain("Bob");
    expect(evidence).toContain("allergic to nuts"); // the claim "Bob is allergic to nuts" is now covered by the evidence
  });
});
