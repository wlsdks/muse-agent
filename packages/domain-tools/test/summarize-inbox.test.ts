import { describe, expect, it } from "vitest";

import { summarizeInbox } from "../src/email-provider.js";

const msg = (subject: string, from: string, unread: boolean) => ({ from, subject, unread });

describe("summarizeInbox", () => {
  it("reports an empty inbox", () => {
    expect(summarizeInbox([])).toBe("Inbox empty.");
  });

  it("pluralizes the count and ends at the head when nothing is unread", () => {
    expect(summarizeInbox([msg("hi", "a@b", false)])).toBe("1 message, 0 unread.");
    expect(summarizeInbox([msg("a", "x", false), msg("b", "y", false), msg("c", "z", false)])).toBe("3 messages, 0 unread.");
  });

  it("lists unread subjects with from, substituting fallbacks for blank subject / sender", () => {
    expect(summarizeInbox([msg("", "", true), msg("Subj", "boss@co", true)])).toBe(
      "2 messages, 2 unread. Unread:\n  - “(no subject)” — (unknown)\n  - “Subj” — boss@co"
    );
  });

  it("caps the unread list at the first 5", () => {
    const seven = Array.from({ length: 7 }, (_, i) => msg(`s${i.toString()}`, `f${i.toString()}`, true));
    const out = summarizeInbox(seven);
    expect(out.split("\n")[0]).toBe("7 messages, 7 unread. Unread:");
    expect(out.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(5);
  });
});
