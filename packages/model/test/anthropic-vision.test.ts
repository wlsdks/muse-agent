import { describe, expect, it } from "vitest";

import { anthropicModelCapabilities } from "../src/provider-anthropic.js";

describe("Anthropic capabilities — vision (F-2)", () => {
  it("declares vision:false: the wire format does not serialize attachments to Anthropic image blocks yet, so a true flag would silently drop images", () => {
    expect(anthropicModelCapabilities("claude-3-7-sonnet").vision).toBe(false);
  });
});
