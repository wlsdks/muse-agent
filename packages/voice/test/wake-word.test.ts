import { describe, expect, it } from "vitest";

import { TextScanWakeWordDetector } from "../src/wake-word.js";

// Direct coverage for the text-scan wake-word detector (untested module). It
// gates the `muse listen --wake` loop — a missed wake leaves the user shouting,
// a SPURIOUS wake on a substring ("museum") barges in unbidden. So the
// whole-word boundary + residual extraction are the load-bearing behaviors.

describe("TextScanWakeWordDetector", () => {
  const detector = () => new TextScanWakeWordDetector({ aliases: ["muse"], phrase: "hey muse" });

  it("rejects an empty phrase and defaults id 'text-scan'", () => {
    expect(() => new TextScanWakeWordDetector({ phrase: "   " })).toThrow();
    expect(new TextScanWakeWordDetector({ phrase: "hey muse" }).id).toBe("text-scan");
  });

  it("detects an exact phrase (no residual) and is case/whitespace/punctuation insensitive", () => {
    const d = detector();
    expect(d.scan("hey muse")).toEqual({ detected: true });
    expect(d.scan("HEY   MUSE")).toEqual({ detected: true }); // case + collapsed whitespace
    expect(d.scan("hey, muse!")).toEqual({ detected: true }); // punctuation normalised away
  });

  it("extracts the residual prompt after the wake phrase, stripping the separator run", () => {
    expect(detector().scan("Hey Muse, what's the weather?")).toEqual({ detected: true, residual: "what's the weather?" });
    expect(detector().scan("hey muse — remind me at 3pm")).toEqual({ detected: true, residual: "remind me at 3pm" });
  });

  it("WHOLE-WORD boundary: 'muse' does NOT fire on 'museum' (no spurious wake)", () => {
    const d = detector();
    expect(d.scan("the museum opens at nine").detected).toBe(false);
    expect(d.scan("amused by the joke").detected).toBe(false);
  });

  it("matches an alias and yields its residual (phrase is tried first, aliases follow)", () => {
    expect(detector().scan("muse remind me")).toEqual({ detected: true, residual: "remind me" });
  });

  it("does not detect on empty text or a transcript without the phrase", () => {
    expect(detector().scan("")).toEqual({ detected: false });
    expect(detector().scan("hello there, how are you")).toEqual({ detected: false });
  });

  it("drops blank/whitespace aliases instead of degrading to a match-everything empty needle", () => {
    const d = new TextScanWakeWordDetector({ aliases: ["   ", ""], phrase: "computer" });
    expect(d.scan("random unrelated text").detected).toBe(false); // a blank alias must NOT match everything
    expect(d.scan("computer status").detected).toBe(true);
  });
});
