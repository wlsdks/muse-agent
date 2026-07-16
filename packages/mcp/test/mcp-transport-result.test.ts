import { describe, expect, it } from "vitest";

import { formatMcpToolResult } from "../src/transport.js";

describe("formatMcpToolResult", () => {
  it("normalizes non-finite MCP wire numbers before they enter Muse JSON values", () => {
    const result = formatMcpToolResult({
      structuredContent: {
        finite: 1,
        infinity: Infinity,
        nested: [Number.NaN, -Infinity]
      }
    });

    expect(result).toEqual({
      finite: 1,
      infinity: null,
      nested: [null, null]
    });
  });
});
