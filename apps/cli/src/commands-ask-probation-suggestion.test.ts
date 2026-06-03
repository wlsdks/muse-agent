import { describe, expect, it } from "vitest";

import { selectProbationSuggestion } from "./commands-ask.js";

type Entry = { readonly id: string; readonly text: string; readonly probation?: boolean };

const entries: readonly Entry[] = [
  { id: "pb_grad", text: "When rescheduling a standup, default to the next business day.", probation: false },
  { id: "pb_essays", text: "Answer questions in one short sentence, no essays.", probation: true },
  { id: "pb_vpn", text: "The office VPN MTU should be 1380 on satellite links.", probation: true }
];

describe("selectProbationSuggestion — recall-time surfacing of an autonomously-distilled learning", () => {
  it("returns the relevant PROBATION strategy the daemon learned from a correction", () => {
    const s = selectProbationSuggestion(entries, "give me a short answer about the deployment");
    expect(s).toEqual({ id: "pb_essays", text: "Answer questions in one short sentence, no essays." });
  });

  it("NEVER suggests a graduated (non-probation) strategy — those are already injected, not suggested", () => {
    // The query overlaps the graduated rescheduling strategy, but it's probation:false → excluded.
    const s = selectProbationSuggestion(entries, "rescheduling the standup business day");
    expect(s).toBeUndefined();
  });

  it("returns undefined when no probation strategy is relevant to the query (no nag)", () => {
    expect(selectProbationSuggestion(entries, "what is the capital of france")).toBeUndefined();
  });

  it("picks the MOST relevant probation strategy when several overlap", () => {
    const s = selectProbationSuggestion(entries, "what MTU for the office VPN on the satellite link");
    expect(s?.id).toBe("pb_vpn");
  });

  it("returns undefined on an empty bank", () => {
    expect(selectProbationSuggestion([], "anything")).toBeUndefined();
  });
});
