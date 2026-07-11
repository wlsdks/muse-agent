import { describe, expect, it } from "vitest";

import { parseObjectiveProposal } from "../src/objective-evaluator.js";

// Parses the LLM's "how would you check this" proposal for a standing
// objective (roadmap D: evidence-gated completion). The default is the
// SAFE one: a garbled / missing / unrecognised proposal stays
// `{"store":"none"}` (⇒ unmet upstream), so an objective is never
// wrongly resolved by an unparseable reply.
describe("parseObjectiveProposal", () => {
  it("reads a clean store proposal with keywords/windowDays/expectedCount", () => {
    expect(parseObjectiveProposal('{"store":"tasks","keywords":["workout"],"windowDays":7,"expectedCount":3}')).toEqual({
      expectedCount: 3,
      keywords: ["workout"],
      store: "tasks",
      windowDays: 7
    });
  });

  it("windowDays/expectedCount are optional", () => {
    expect(parseObjectiveProposal('{"store":"reminders","keywords":["call","mom"]}')).toEqual({
      keywords: ["call", "mom"],
      store: "reminders"
    });
  });

  it("reads {store:none} as the honest terminal for an un-observable objective", () => {
    expect(parseObjectiveProposal('{"store":"none"}')).toEqual({ store: "none" });
  });

  it("reads unmeetable with the model's reason, or a default reason when none given", () => {
    expect(parseObjectiveProposal('{"store":"none","unmeetable":true,"reason":"the repo was deleted"}')).toEqual({
      reason: "the repo was deleted",
      store: "none",
      unmeetable: true
    });
    expect(parseObjectiveProposal('{"store":"none","unmeetable":true}')).toEqual({
      reason: "model deemed the objective unmeetable",
      store: "none",
      unmeetable: true
    });
  });

  it("defaults to store:none for non-JSON, an unrecognised store, and a store with no usable keywords", () => {
    expect(parseObjectiveProposal("the build is still going, I think")).toEqual({ store: "none" });
    expect(parseObjectiveProposal('{"store":"weather","keywords":["rain"]}')).toEqual({ store: "none" });
    expect(parseObjectiveProposal('{"store":"tasks","keywords":[]}')).toEqual({ store: "none" });
    expect(parseObjectiveProposal('{"store":"tasks","keywords":["  "]}')).toEqual({ store: "none" });
  });

  it("extracts the proposal from a fenced ```json block preceded by a <think> block", () => {
    expect(
      parseObjectiveProposal('<think>let me decide</think>\n```json\n{"store":"tasks","keywords":["workout"]}\n```')
    ).toEqual({ keywords: ["workout"], store: "tasks" });
  });

  it("takes the LAST balanced JSON candidate when several are present", () => {
    expect(
      parseObjectiveProposal('first {"store":"none"} then {"store":"tasks","keywords":["workout"]}')
    ).toEqual({ keywords: ["workout"], store: "tasks" });
  });

  it("does NOT leak a NESTED store as a proposal — no false evidence query from a nested object", () => {
    expect(
      parseObjectiveProposal('{"plan":{"store":"tasks","keywords":["x"]},"note":"actually not yet"}')
    ).toEqual({ store: "none" });
  });

  it("still reads a TOP-LEVEL store even when the object also has a nested store", () => {
    expect(
      parseObjectiveProposal('{"store":"none","detail":{"store":"tasks","keywords":["x"]}}')
    ).toEqual({ store: "none" });
  });
});
