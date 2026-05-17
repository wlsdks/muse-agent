import type { SpeechToTextProvider } from "@muse/voice";

import { describe, expect, it } from "vitest";

import { safeTranscribe } from "./commands-listen.js";

function stt(impl: () => Promise<{ text: string }>): SpeechToTextProvider {
  return {
    describe: () => ({ description: "", displayName: "stub", id: "stub", local: true, supportedFormats: ["audio/wav"] }),
    id: "stub",
    transcribe: impl
  } as unknown as SpeechToTextProvider;
}

const req = { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" };

describe("safeTranscribe (wake-loop STT resilience)", () => {
  it("returns the trimmed transcript on success", async () => {
    const out: string[] = [];
    const text = await safeTranscribe(
      stt(async () => ({ text: "  hey muse what's the time  " })),
      req,
      { stderr: (s: string) => out.push(s) }
    );
    expect(text).toBe("hey muse what's the time");
    expect(out).toEqual([]);
  });

  it("never throws into the loop on a transient STT failure — logs + returns undefined", async () => {
    const out: string[] = [];
    const text = await safeTranscribe(
      stt(async () => { throw new Error("ECONNRESET whisper endpoint"); }),
      req,
      { stderr: (s: string) => out.push(s) }
    );
    // Resolved (did NOT propagate) so the continuous wake loop survives.
    expect(text).toBeUndefined();
    expect(out.join("")).toContain("transcription failed (resuming listen)");
    expect(out.join("")).toContain("ECONNRESET whisper endpoint");
  });

  it("returns an empty string (caller treats as skip) for a silent clip", async () => {
    const text = await safeTranscribe(stt(async () => ({ text: "   " })), req, { stderr: () => {} });
    expect(text).toBe("");
  });
});
