import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import type { SpeechToTextProvider, TextToSpeechProvider } from "@muse/voice";
import { Command } from "commander";

import { describe, expect, it } from "vitest";

import { registerListenCommand, safeTranscribe, type ListenHelpers } from "./commands-listen.js";

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

describe("muse listen — full mic→STT→agent→TTS round-trip (P4-b2)", () => {
  it("captured audio is transcribed, sent to the agent, the reply is synthesised and played", async () => {
    const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
    const TTS_AUDIO = new Uint8Array([9, 8, 7]);

    function fakeRec() {
      const rec = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        kill: (signal?: string) => void;
      };
      rec.stdout = new EventEmitter();
      rec.kill = () => {
        rec.stdout.emit("data", WAV);
        rec.emit("close");
      };
      return rec;
    }

    const seen: {
      chatBody?: Record<string, unknown>;
      sttAudioBytes?: number;
      ttsText?: string;
      playedBytes?: Uint8Array;
    } = {};

    const stdoutChunks: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => stdoutChunks.push(m) };

    const sttProvider = {
      describe: () => ({ description: "", displayName: "s", id: "s", local: true, supportedFormats: ["audio/wav"] }),
      id: "s",
      transcribe: async (r: { audio: Uint8Array }) => {
        seen.sttAudioBytes = r.audio.byteLength;
        return { text: "what's the weather today" };
      }
    } as unknown as SpeechToTextProvider;

    const ttsProvider = {
      describe: () => ({ description: "", displayName: "t", id: "t", local: true, supportedFormats: ["mp3"] }),
      id: "t",
      synthesize: async (r: { text: string; format?: string }) => {
        seen.ttsText = r.text;
        return { audio: TTS_AUDIO, format: r.format ?? "mp3" };
      }
    } as unknown as TextToSpeechProvider;

    const helpers: ListenHelpers = {
      apiRequest: async (_io, _cmd, path, body) => {
        expect(path).toBe("/api/chat");
        seen.chatBody = body;
        return { content: "It is sunny in Seoul." };
      },
      buildVoiceProviders: () => ({ stt: sttProvider, tts: ttsProvider }),
      shells: {
        playAudio: async (filePath: string) => {
          seen.playedBytes = new Uint8Array(readFileSync(filePath));
        },
        spawnRec: () => fakeRec() as unknown as ChildProcess,
        waitForEnter: async () => {},
        which: (bin: string) => (bin === "sox" ? "/usr/bin/sox" : undefined)
      }
    };

    const program = new Command();
    registerListenCommand(program, io, helpers);
    await program.parseAsync(["node", "muse", "listen"]);

    // mic → STT (the captured WAV bytes reached the transcriber)
    expect(seen.sttAudioBytes).toBe(WAV.byteLength);
    // STT → agent (the transcript was sent to /api/chat)
    expect(seen.chatBody).toEqual({ message: "what's the weather today" });
    // agent → TTS (the agent reply was synthesised)
    expect(seen.ttsText).toBe("It is sunny in Seoul.");
    // TTS → playback (the synthesised audio was written and played)
    expect(seen.playedBytes).toEqual(TTS_AUDIO);
    expect(stdoutChunks.join("")).toContain("You: what's the weather today");
    expect(stdoutChunks.join("")).toContain("Muse: It is sunny in Seoul.");
  });
});
