import { describe, expect, it } from "vitest";

import { parseObjectiveVerdict } from "../src/objective-evaluator.js";

// Parses the LLM's re-evaluation verdict for a standing objective. The default
// is the SAFE one: a garbled / missing / unknown verdict stays `unmet`, so an
// objective is never wrongly resolved or cancelled by an unparseable reply.
describe("parseObjectiveVerdict", () => {
  it("reads a clean met / unmet verdict", () => {
    expect(parseObjectiveVerdict('{"outcome":"met"}')).toEqual({ outcome: "met" });
    expect(parseObjectiveVerdict('{"outcome":"unmet"}')).toEqual({ outcome: "unmet" });
  });

  it("reads unmeetable with the model's reason, or a default reason when none given", () => {
    expect(parseObjectiveVerdict('{"outcome":"unmeetable","reason":"the repo was deleted"}')).toEqual({
      outcome: "unmeetable",
      reason: "the repo was deleted"
    });
    expect(parseObjectiveVerdict('{"outcome":"unmeetable"}')).toEqual({
      outcome: "unmeetable",
      reason: "model deemed the objective unmeetable"
    });
  });

  it("defaults to unmet for non-JSON, and for a recognised-shape JSON with an UNKNOWN outcome", () => {
    expect(parseObjectiveVerdict("the build is still going, I think")).toEqual({ outcome: "unmet" });
    expect(parseObjectiveVerdict('{"outcome":"bogus"}')).toEqual({ outcome: "unmet" });
  });

  it("extracts the verdict from a fenced ```json block preceded by a <think> block", () => {
    expect(parseObjectiveVerdict('<think>let me decide</think>\n```json\n{"outcome":"met"}\n```')).toEqual({ outcome: "met" });
  });

  it("takes the LAST balanced JSON candidate when several are present", () => {
    expect(parseObjectiveVerdict('first {"outcome":"unmet"} then {"outcome":"met"}')).toEqual({ outcome: "met" });
  });

  it("does NOT leak a NESTED outcome as a verdict — no false `met` from a nested object", () => {
    // The top-level object has no `outcome`; the only `outcome:met` is NESTED. A
    // nested-only verdict is ambiguous ⇒ the conservative `unmet` safe default,
    // never a false autonomous completion.
    expect(parseObjectiveVerdict('{"plan":{"outcome":"met"},"note":"actually not yet"}')).toEqual({ outcome: "unmet" });
    expect(parseObjectiveVerdict('{"steps":[{"outcome":"met"}],"done":false}')).toEqual({ outcome: "unmet" });
  });

  it("still reads a TOP-LEVEL outcome even when the object also has a nested outcome", () => {
    // The top-level outcome is the real verdict; a nested one must not override it.
    expect(parseObjectiveVerdict('{"outcome":"unmet","detail":{"outcome":"met"}}')).toEqual({ outcome: "unmet" });
  });
});
