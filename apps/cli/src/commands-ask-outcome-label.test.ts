import { describe, expect, it } from "vitest";

import { askOutcomeLabel } from "./commands-ask.js";

describe("askOutcomeLabel (cli.local trace outcome label)", () => {
  it("labels a refusal as abstain regardless of the verdict", () => {
    expect(askOutcomeLabel({ refusal: true, verdict: null })).toBe("abstain");
    expect(askOutcomeLabel({ refusal: true, verdict: "grounded" })).toBe("abstain");
    expect(askOutcomeLabel({ refusal: true, verdict: "ungrounded" })).toBe("abstain");
  });

  it("passes the rubric verdict through on a non-refusal answer", () => {
    expect(askOutcomeLabel({ refusal: false, verdict: "grounded" })).toBe("grounded");
    expect(askOutcomeLabel({ refusal: false, verdict: "ungrounded" })).toBe("ungrounded");
  });

  it("stays null when the verdict never ran (json mode / vision skip)", () => {
    expect(askOutcomeLabel({ refusal: false, verdict: null })).toBeNull();
  });
});
