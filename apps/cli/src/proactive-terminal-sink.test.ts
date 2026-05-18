import { describe, expect, it } from "vitest";

import { createTerminalProactiveSink, formatProactiveTerminalNotice } from "./proactive-terminal-sink.js";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

describe("formatProactiveTerminalNotice", () => {
  it("wraps the notice in a prompt-clearing prefix and a trailing newline", () => {
    const out = formatProactiveTerminalNotice({ kind: "calendar", text: "⏰ Standup in 5 min", title: "Standup" });
    expect(out.startsWith(`${CR}${ESC}[K`)).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("⏰ Standup in 5 min");
  });

  it("strips untrusted control / C1 bytes from the third-party text", () => {
    const hostile = `${ESC}[31mRED${ESC}[0m${String.fromCharCode(7)}bell${String.fromCharCode(0x9b)}c1 done`;
    const out = formatProactiveTerminalNotice({ kind: "task", text: hostile, title: "x" });
    // Only the deliberate leading `\r\x1b[K` may contain ESC; the
    // rendered text body must carry no raw control/C1 bytes.
    const body = out.slice(`${CR}${ESC}[K`.length, -1);
    expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(body)).toBe(false);
    expect(body).toBe("[31mRED[0mbellc1 done");
  });
});

describe("createTerminalProactiveSink", () => {
  it("writes the formatted notice and redraws the prompt once", () => {
    const writes: string[] = [];
    let redraws = 0;
    const sink = createTerminalProactiveSink({
      redrawPrompt: () => { redraws += 1; },
      write: (chunk) => { writes.push(chunk); }
    });
    const notice = { kind: "calendar", text: "📋 Submit memo due in 3 min", title: "Submit memo" };
    sink.deliver(notice);
    expect(writes).toEqual([formatProactiveTerminalNotice(notice)]);
    expect(redraws).toBe(1);
  });

  it("works without a redrawPrompt callback (foreground daemon, no readline)", () => {
    const writes: string[] = [];
    const sink = createTerminalProactiveSink({ write: (chunk) => { writes.push(chunk); } });
    sink.deliver({ kind: "task", text: "hello", title: "t" });
    expect(writes.length).toBe(1);
    expect(writes[0]?.endsWith("hello\n")).toBe(true);
  });
});
