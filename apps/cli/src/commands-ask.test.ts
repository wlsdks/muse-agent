import { describe, expect, it } from "vitest";

import { consumeAskStream, parseBoundedInt, type AskStreamEvent } from "./commands-ask.js";

async function* gen(events: AskStreamEvent[]): AsyncIterable<AskStreamEvent> {
  for (const e of events) yield e;
}

describe("parseBoundedInt (goal 178)", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseBoundedInt(undefined, "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("", "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("   ", "--top", 1, 20, 3)).toBe(3);
  });

  it("accepts a genuine number, truncating and clamping to max", () => {
    expect(parseBoundedInt("5", "--top", 1, 20, 3)).toBe(5);
    expect(parseBoundedInt(" 7 ", "--top", 1, 20, 3)).toBe(7);
    expect(parseBoundedInt("4.9", "--top", 1, 20, 3)).toBe(4);
    expect(parseBoundedInt("999", "--top", 1, 20, 3)).toBe(20); // clamp high
  });

  it("rejects a unit slip / non-numeric / below-min instead of silently defaulting", () => {
    expect(() => parseBoundedInt("5x", "--top", 1, 20, 3)).toThrow(/--top must be an integer in \[1, 20\]/u);
    expect(() => parseBoundedInt("abc", "--top", 1, 20, 3)).toThrow(/got 'abc'/u);
    expect(() => parseBoundedInt("0", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
    expect(() => parseBoundedInt("-2", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
  });

  it("works for the --calendar-days bounds too", () => {
    expect(parseBoundedInt("14", "--calendar-days", 1, 30, 7)).toBe(14);
    expect(parseBoundedInt("60", "--calendar-days", 1, 30, 7)).toBe(30);
    expect(() => parseBoundedInt("14d", "--calendar-days", 1, 30, 7))
      .toThrow(/--calendar-days must be an integer in \[1, 30\]/u);
  });
});

describe("consumeAskStream", () => {
  it("accumulates text-delta events and forwards each delta", async () => {
    const seen: string[] = [];
    const res = await consumeAskStream(
      gen([
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
        { type: "done" }
      ]),
      (t) => seen.push(t),
      () => false
    );
    expect(res).toEqual({ answer: "Hello world" });
    expect(seen).toEqual(["Hello", " world"]);
  });

  it("surfaces a provider error instead of silently dropping it", async () => {
    const res = await consumeAskStream(
      gen([
        { type: "text-delta", text: "partial" },
        { type: "error", error: { message: "run `ollama pull qwen3:8b`" } }
      ]),
      () => {},
      () => false
    );
    expect(res.error).toBe("run `ollama pull qwen3:8b`");
    expect(res.answer).toBe("partial"); // partial output preserved
  });

  it("falls back to a generic message when the error carries none", async () => {
    const res = await consumeAskStream(
      gen([{ type: "error" }]),
      () => {},
      () => false
    );
    expect(res.error).toBe("model request failed");
  });

  it("stops forwarding once aborted", async () => {
    const seen: string[] = [];
    let calls = 0;
    const res = await consumeAskStream(
      gen([
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" }
      ]),
      (t) => seen.push(t),
      () => (calls++ > 0) // aborted from the 2nd iteration on
    );
    expect(seen).toEqual(["a"]);
    expect(res.answer).toBe("a");
    expect(res.error).toBeUndefined();
  });
});
