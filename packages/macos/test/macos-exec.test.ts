import { describe, expect, it } from "vitest";

import { escapeAppleScript, isPermissionError } from "../src/macos-exec.js";

describe("escapeAppleScript", () => {
  it("backslash-escapes backslashes and double-quotes for an AppleScript string literal", () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAppleScript("a\\b")).toBe("a\\\\b");
    // backslash is escaped first, so a quote-after-backslash stays two escapes
    expect(escapeAppleScript('\\"')).toBe('\\\\\\"');
  });

  it("flattens newlines (CR/LF and runs) to a single space — AppleScript literals can't carry a raw newline", () => {
    expect(escapeAppleScript("line1\nline2")).toBe("line1 line2");
    expect(escapeAppleScript("a\r\n\nb")).toBe("a b");
    expect(escapeAppleScript("a\r\rb")).toBe("a b");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeAppleScript("hello world")).toBe("hello world");
    expect(escapeAppleScript("")).toBe("");
  });
});

describe("isPermissionError", () => {
  it("matches the canonical osascript -1743 not-authorised codes/phrasings (case-insensitive)", () => {
    expect(isPermissionError("execution error: not authorized to send Apple events (-1743)")).toBe(true);
    expect(isPermissionError("error -1743")).toBe(true);
    expect(isPermissionError("Not Allowed")).toBe(true);
    expect(isPermissionError("you don't have permission")).toBe(true);
    expect(isPermissionError("not authorised")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isPermissionError("command not found")).toBe(false);
    expect(isPermissionError("timed out")).toBe(false);
    expect(isPermissionError("")).toBe(false);
  });
});
