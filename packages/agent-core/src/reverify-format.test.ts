import { describe, expect, it } from "vitest";

import { parseGroundingReverifyJson, REVERIFY_RESPONSE_FORMAT } from "./knowledge-recall.js";

describe("schema-constrained reverify verdict", () => {
  it("the response format requires a boolean `supported`", () => {
    expect(REVERIFY_RESPONSE_FORMAT.type).toBe("object");
    expect(REVERIFY_RESPONSE_FORMAT.required).toContain("supported");
    expect(REVERIFY_RESPONSE_FORMAT.properties.supported.type).toBe("boolean");
  });

  it("parses the constrained JSON verdict", () => {
    expect(parseGroundingReverifyJson('{"supported": true}')).toBe(true);
    expect(parseGroundingReverifyJson(' {"supported":false} ')).toBe(false);
  });

  it("fail-close on a non-boolean or missing field", () => {
    expect(parseGroundingReverifyJson('{"supported": "yes"}')).toBe(false);
    expect(parseGroundingReverifyJson("{}")).toBe(false);
  });

  it("falls back to the legacy YES-word parse when the output is not JSON", () => {
    expect(parseGroundingReverifyJson("YES")).toBe(true);
    expect(parseGroundingReverifyJson("NO")).toBe(false);
    expect(parseGroundingReverifyJson("")).toBe(false);
    expect(parseGroundingReverifyJson("hmm, not sure")).toBe(false);
  });
});
