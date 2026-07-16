import { EventEmitter } from "node:events";

import type { SpeechToTextProvider } from "@muse/voice";
import { describe, expect, it } from "vitest";

import type { ListenShells } from "./commands-listen.js";
import { captureVoiceText } from "./voice-capture.js";

// Mirror commands-listen.test.ts's mic mock: spawnRec returns a child whose
// stdout emits the WAV bytes then 'close'. No real mic/whisper needed — this is
// the repo's standard verification for the voice path.
function recEmitting(wav: Buffer | null) {
  const rec = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
  rec.stdout = new EventEmitter();
  rec.kill = () => undefined;
  setImmediate(() => {
    if (wav) rec.stdout.emit("data", wav);
    rec.emit("close", 0, null);
  });
  return rec;
}
const shellsEmitting = (wav: Buffer | null): ListenShells =>
  ({ spawnRec: () => recEmitting(wav) } as unknown as ListenShells);

const stt = (impl: SpeechToTextProvider["transcribe"]): SpeechToTextProvider =>
  ({ transcribe: impl } as unknown as SpeechToTextProvider);

const silentIo = { stderr: () => undefined };

describe("captureVoiceText — SB-2 voice capture (mic clip → STT → text)", () => {
  it("records a clip and returns the trimmed transcript", async () => {
    const text = await captureVoiceText(
      { clipSeconds: 1, shells: shellsEmitting(Buffer.from("WAVDATA")), stt: stt(async () => ({ text: "  buy milk after the dentist  " })) },
      silentIo
    );
    expect(text).toBe("buy milk after the dentist");
  });

  it("returns undefined when no audio was captured (no mic / silence) — never writes an empty entry", async () => {
    const text = await captureVoiceText(
      { clipSeconds: 1, shells: shellsEmitting(null), stt: stt(async () => ({ text: "should not be called" })) },
      silentIo
    );
    expect(text).toBeUndefined();
  });

  it("is fail-soft: a throwing STT yields undefined (safeTranscribe swallows the blip)", async () => {
    const text = await captureVoiceText(
      { clipSeconds: 1, shells: shellsEmitting(Buffer.from("WAV")), stt: stt(async () => { throw new Error("whisper model missing"); }) },
      silentIo
    );
    expect(text).toBeUndefined();
  });

  it("returns undefined when transcription is blank (only whitespace)", async () => {
    const text = await captureVoiceText(
      { clipSeconds: 1, shells: shellsEmitting(Buffer.from("WAV")), stt: stt(async () => ({ text: "   " })) },
      silentIo
    );
    expect(text).toBeUndefined();
  });

  it("passes the language hint through to the STT request", async () => {
    let seenLang: string | undefined;
    await captureVoiceText(
      { clipSeconds: 1, language: "ko", shells: shellsEmitting(Buffer.from("WAV")), stt: stt(async (req: { language?: string }) => { seenLang = req.language; return { text: "안녕" }; }) },
      silentIo
    );
    expect(seenLang).toBe("ko");
  });
});
