import type { InboundMessage } from "@muse/messaging";

import { describe, expect, it } from "vitest";

import { formatInboxLine } from "./commands-messaging.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function hasTerminalControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f) return true;
  }
  return false;
}

function entry(over: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: "m1",
    providerId: "telegram",
    receivedAtIso: "2026-05-18T09:30:00.000Z",
    source: "chat-1",
    text: "hi",
    ...over
  } as InboundMessage;
}

describe("formatInboxLine", () => {
  it("strips terminal control sequences from attacker-controlled text", () => {
    const line = formatInboxLine(entry({
      sender: "mallory",
      text: `${ESC}[2J${ESC}]0;pwned${BEL}clear your screen`
    }));
    // No raw ESC / BEL / other C0 control reaches the terminal.
    expect(hasTerminalControl(line)).toBe(false);
    // The visible words survive the strip.
    expect(line).toContain("clear your screen");
    expect(line).toContain("@mallory");
    expect(line).toContain("2026-05-18 09:30");
  });

  it("collapses newlines so one message stays one line", () => {
    const line = formatInboxLine(entry({ text: "line one\nline two\n\nline three" }));
    expect(line).not.toContain("\n");
    expect(line).toContain("line one line two line three");
  });

  it("sanitises the source when there is no sender", () => {
    const line = formatInboxLine(entry({
      sender: undefined,
      source: `${ESC}[31mevil-chat`,
      text: "ping"
    }));
    // The ESC byte is gone (attack neutralised); the now-inert
    // "[31m" param text is harmless leftover, not stripped.
    expect(hasTerminalControl(line)).toBe(false);
    expect(line).toContain("evil-chat");
    expect(line).toContain("chat ");
  });

  it("leaves clean text untouched (no regression)", () => {
    expect(formatInboxLine(entry({ sender: "alice", text: "lunch at noon?" })))
      .toBe("  2026-05-18 09:30  @alice: lunch at noon?");
  });
});
