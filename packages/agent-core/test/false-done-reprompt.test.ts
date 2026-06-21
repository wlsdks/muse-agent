import { describe, expect, it } from "vitest";

import { runResistingFalseDone } from "../src/false-done-reprompt.js";

const FIX_QUERY = "fix the bug in add.ts";
const res = (output: string, toolsUsed: readonly string[] = []) => ({ response: { output }, toolsUsed });

describe("runResistingFalseDone — bounded clean-history re-run on an unbacked false-done", () => {
  it("re-runs ONCE and KEEPS the re-run when the first claimed a fix but ran no actuator and the re-run acts", async () => {
    let retries = 0;
    const out = await runResistingFalseDone({
      query: FIX_QUERY,
      firstResult: res("I fixed the bug.", []), // claim + NO actuator → unbacked
      retry: async () => {
        retries += 1;
        return res("Done.", ["file_edit"]); // the clean re-run actually edits
      }
    });
    expect(retries).toBe(1);
    expect(out.toolsUsed).toEqual(["file_edit"]);
  });

  it("does NOT re-run when the first result already acted (a real edit)", async () => {
    let retries = 0;
    const first = res("I fixed the bug.", ["file_edit"]);
    const out = await runResistingFalseDone({
      query: FIX_QUERY,
      firstResult: first,
      retry: async () => { retries += 1; return res("x", ["file_edit"]); }
    });
    expect(retries).toBe(0);
    expect(out).toBe(first);
  });

  it("does NOT re-run when it isn't an action request / has no claim", async () => {
    let retries = 0;
    const first = res("The add function returns a - b.", []);
    const out = await runResistingFalseDone({
      query: "what does add.ts do?",
      firstResult: first,
      retry: async () => { retries += 1; return res("x", ["file_edit"]); }
    });
    expect(retries).toBe(0);
    expect(out).toBe(first);
  });

  it("re-runs at most ONCE and KEEPS THE FIRST when the re-run ALSO fails to act (never let a 2nd unbacked replace the 1st)", async () => {
    let retries = 0;
    const first = res("I fixed the bug.", []);
    const out = await runResistingFalseDone({
      query: FIX_QUERY,
      firstResult: first,
      retry: async () => { retries += 1; return res("I fixed it again.", []); } // still no actuator
    });
    expect(retries).toBe(1); // bounded — exactly one retry, no loop
    expect(out).toBe(first); // the unbacked re-run is discarded; original stands for the downstream notice
  });
});
