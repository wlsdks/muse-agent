import { describe, expect, it } from "vitest";

import { MUSE_CACHE_BOUNDARY_MARKER } from "@muse/prompts";

import {
  sanitizeMessagesForProvider,
  sanitizeRequestForProvider
} from "../src/prompt-cache-safety.js";

describe("sanitizeRequestForProvider (iter 10)", () => {
  it("strips the cache-boundary marker from every message before the provider sees it", () => {
    const request = {
      messages: [
        { content: `You are Muse.\n${MUSE_CACHE_BOUNDARY_MARKER}\n[User Memory] ...`, role: "system" as const },
        { content: "hi", role: "user" as const }
      ],
      model: "diagnostic/smoke"
    };
    const sanitized = sanitizeRequestForProvider(request);
    expect(sanitized).not.toBe(request);
    expect(sanitized.messages[0]?.content).not.toContain(MUSE_CACHE_BOUNDARY_MARKER);
    expect(sanitized.messages[0]?.content).toContain("You are Muse.");
    expect(sanitized.messages[0]?.content).toContain("[User Memory]");
    // unrelated message untouched
    expect(sanitized.messages[1]).toBe(request.messages[1]);
  });

  it("returns the SAME object when no message contains the marker (no needless allocation)", () => {
    const request = {
      messages: [
        { content: "You are Muse.", role: "system" as const },
        { content: "hi", role: "user" as const }
      ],
      model: "diagnostic/smoke"
    };
    const sanitized = sanitizeRequestForProvider(request);
    expect(sanitized).toBe(request);
  });

  it("sanitizeMessagesForProvider preserves array identity when no marker is present", () => {
    const messages = [{ content: "hi", role: "user" as const }];
    expect(sanitizeMessagesForProvider(messages)).toBe(messages);
  });
});
