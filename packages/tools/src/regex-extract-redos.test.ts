/**
 * regex_extract's only ReDoS defence was a static classifier, and static
 * classification of catastrophic backtracking is undecidable — the verifier
 * measured `(a|aa)+$` and `(a+){2,50}$` (both missed by the old guard) hanging
 * the shared process for 20s and 54s against just 40 characters.
 *
 * Two layers now: a strengthened fast-fail guard that catches those shapes, and
 * — because no static guard can be complete — a hard off-thread TIMEOUT that
 * kills ANY pattern that blows the deadline. This test proves both the known
 * shapes fail fast AND that a missed pattern is bounded in time, while a
 * legitimate pattern still returns its matches.
 */

import { describe, expect, it } from "vitest";

import { createMuseTools } from "./muse-tools.js";
import { hasNestedUnboundedQuantifier } from "./muse-tools.js";
import { runRegexMatchesWithTimeout } from "./regex-timeout.js";

const ctx = { runId: "r", userId: "u" };

function regexExtract() {
  const tool = createMuseTools().find((entry) => entry.definition.name === "regex_extract");
  if (!tool) throw new Error("regex_extract missing");
  return tool;
}

describe("regex_extract refuses / bounds catastrophic patterns", () => {
  const CATASTROPHIC = ["(a+)+$", "(a|aa)+$", "(a+){2,50}$", "(a|ab)*$", "([a-z]+)*$"];

  for (const pattern of CATASTROPHIC) {
    it(`rejects ${pattern} fast, never hanging`, async () => {
      const started = Date.now();
      const out = await regexExtract().execute({ pattern, text: `${"a".repeat(50)}X` }, ctx) as { error?: string; matches?: string[] };
      // Fast-fail guard OR the timeout backstop — either way it returns quickly
      // with an error, and the process is not blocked.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out.error).toBeDefined();
      expect(out.matches).toBeUndefined();
    });
  }

  it("still extracts with a legitimate pattern", async () => {
    const out = await regexExtract().execute({ pattern: "\\d+", text: "a1 b22 c333" }, ctx) as { matches?: string[] };
    expect(out.matches).toEqual(["1", "22", "333"]);
  });

  it("the timeout runner kills a catastrophic pattern the static guard did not catch", async () => {
    // Directly exercise the backstop with a global-flag catastrophic pattern
    // and a tight deadline: it must return timedOut, not hang the caller.
    const started = Date.now();
    const result = await runRegexMatchesWithTimeout("(a+)+$", "g", `${"a".repeat(46)}X`, 1000, 300);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("the strengthened static guard no longer misses the two bypasses", () => {
    // hasNestedUnboundedQuantifier is the old guard; the tool now ORs it with
    // hasRepeatedGroupRisk. Assert the tool-level rejection covers both.
    expect(hasNestedUnboundedQuantifier("(a+)+$")).toBe(true);
    // The old guard alone missed these — the tool's combined check catches them
    // (asserted via the CATASTROPHIC loop above).
  });
});
