import { describe, expect, it } from "vitest";

import { buildSystemPrompt, MUSE_CACHE_BOUNDARY_MARKER } from "../src/index.js";

// Snapshot of the behavior-critical SYSTEM-PROMPT ASSEMBLY (backlog P5). The
// section composition + ORDER + the prompt-cache boundary placement shape every
// response and the cache-hit boundary, so an accidental reorder/edit silently
// changes behavior. Pins the full assembly for a rich input; an intentional
// change updates the snapshot in review, an accidental one fails.
describe("buildSystemPrompt — section-assembly snapshot", () => {
  const RICH = {
    basePrompt: "You are Muse.",
    includeCacheBoundary: true,
    responseFormat: "json" as const,
    retrievedContext: "[Knowledge]\n- doc1",
    toolResults: "[Tool Results]\n- time_now -> 3pm",
    userMemoryContext: "[User Memory]\n- home_city: Seoul",
  };

  it("renders the exact section assembly for a rich input", () => {
    expect(buildSystemPrompt(RICH)).toMatchInlineSnapshot(`
      "You are Muse.

      [Response Format]
      Respond with valid JSON only.
      - Do not wrap the response in markdown code fences.
      - Do not include text before or after the JSON value.
      - The response must start with '{' or '[' and end with '}' or ']'.

      <!-- MUSE_CACHE_BOUNDARY -->

      [User Memory]
      [User Memory]
      - home_city: Seoul

      [Retrieved Context]
      The following information was retrieved from a knowledge source and may be relevant.
      Use it when it directly supports the answer.
      If it does not contain the answer, say that the available sources do not answer it.
      Do not fill private workspace gaps with general knowledge.

      [Knowledge]
      - doc1

      [Tool Results]
      The following information came from executed tools, not from retrieved documents.
      Use tool results as the primary source for current runtime facts.
      If tool results and retrieved context conflict, prefer the newer or more authoritative source.

      [Tool Results]
      - time_now -> 3pm"
    `);
  });

  it("holds the assembly invariants (base first, cache boundary before the dynamic sections, ordered sections)", () => {
    const out = buildSystemPrompt(RICH);
    expect(out.startsWith("You are Muse.")).toBe(true);
    // the cache boundary sits AFTER the stable base + response-format and BEFORE
    // the per-request memory/context sections (so the stable prefix caches).
    const boundary = out.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(boundary).toBeGreaterThan(out.indexOf("[Response Format]"));
    expect(boundary).toBeLessThan(out.indexOf("[User Memory]"));
    // dynamic sections appear in their fixed order
    expect(out.indexOf("[User Memory]")).toBeLessThan(out.indexOf("[Retrieved Context]"));
    expect(out.indexOf("[Retrieved Context]")).toBeLessThan(out.indexOf("[Tool Results]"));
  });

  it("emits only the base prompt when no sections are supplied", () => {
    expect(buildSystemPrompt({ basePrompt: "You are Muse." })).toBe("You are Muse.");
  });
});
