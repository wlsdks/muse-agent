import { describe, expect, it } from "vitest";

import {
  APPLE_SCRIPT_DEFAULT_TIMEOUT_MS,
  APPLE_SCRIPT_MAX_TIMEOUT_MS,
  normalizeAppleScriptTimeout,
  quoteAppleScriptString
} from "../src/apple-script-shared.js";

describe("AppleScript provider boundaries", () => {
  it("uses a bounded, positive timeout for all configured process values", () => {
    expect(normalizeAppleScriptTimeout(undefined)).toBe(APPLE_SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(normalizeAppleScriptTimeout(Number.NaN)).toBe(APPLE_SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(normalizeAppleScriptTimeout(0)).toBe(APPLE_SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(normalizeAppleScriptTimeout(12.9)).toBe(12);
    expect(normalizeAppleScriptTimeout(1e100)).toBe(APPLE_SCRIPT_MAX_TIMEOUT_MS);
  });

  it("keeps quotes, backslashes, and line endings inside one AppleScript literal", () => {
    expect(quoteAppleScriptString('one\\two "three"\r\nfour')).toBe('"one\\\\two \\"three\\"\\r\\nfour"');
  });
});
