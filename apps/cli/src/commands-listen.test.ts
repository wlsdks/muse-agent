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

describe("muse listen — full mic→STT→agent→TTS round-trip", () => {
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

describe("muse listen (push-to-talk) — a failed transcribe ends cleanly, not as a raw unhandled throw", () => {
  it("surfaces 'transcription failed' + exits without calling the agent when STT throws", async () => {
    const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
    function fakeRec(): ChildProcess {
      const rec = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: (s?: string) => void };
      rec.stdout = new EventEmitter();
      rec.kill = () => { rec.stdout.emit("data", WAV); rec.emit("close"); };
      return rec as unknown as ChildProcess;
    }

    const stderrChunks: string[] = [];
    const io = { stderr: (m: string) => stderrChunks.push(m), stdout: () => {} };
    let chatCalled = false;
    const ttsProvider = {
      describe: () => ({ description: "", displayName: "t", id: "t", local: true, supportedFormats: ["mp3"] }),
      id: "t",
      synthesize: async () => ({ audio: new Uint8Array([1]), format: "mp3" })
    } as unknown as TextToSpeechProvider;

    const helpers: ListenHelpers = {
      apiRequest: async () => { chatCalled = true; return { content: "should not reach here" }; },
      buildVoiceProviders: () => ({ stt: stt(async () => { throw new Error("whisper model not found"); }), tts: ttsProvider }),
      shells: {
        playAudio: async () => {},
        spawnRec: () => fakeRec(),
        waitForEnter: async () => {},
        which: (bin: string) => (bin === "sox" ? "/usr/bin/sox" : undefined)
      }
    };

    const program = new Command();
    program.exitOverride();
    registerListenCommand(program, io, helpers);
    await expect(program.parseAsync(["node", "muse", "listen"])).rejects.toThrow();
    expect(stderrChunks.join("")).toContain("transcription failed: whisper model not found");
    expect(chatCalled, "a failed transcribe must NOT reach the agent /api/chat").toBe(false);
  });
});

describe("muse listen --wake — a transient STT failure on the follow-up prompt resumes the session, never breaks it", () => {
  it("routes the follow-up transcription through safeTranscribe (an STT 5xx resumes listening, not crash)", async () => {
    const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

    function fakeRec(): ChildProcess {
      const rec = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: (s?: string) => void };
      rec.stdout = new EventEmitter();
      rec.kill = () => {};
      // Self-close on next tick so captureWavForSeconds resolves
      // without waiting on its real per-clip timer.
      setImmediate(() => { rec.stdout.emit("data", WAV); rec.emit("close"); });
      return rec as unknown as ChildProcess;
    }

    let recCalls = 0;
    let sttCalls = 0;
    const stderrChunks: string[] = [];
    const io = { stderr: (m: string) => stderrChunks.push(m), stdout: () => {} };

    const sttProvider = {
      describe: () => ({ description: "", displayName: "s", id: "s", local: true, supportedFormats: ["audio/wav"] }),
      id: "s",
      transcribe: async () => {
        sttCalls += 1;
        if (sttCalls === 1) return { text: "hey muse" };           // wake fires, no residual → follow-up capture
        if (sttCalls === 2) throw new Error("stt 503 transient");  // follow-up STT blip
        return { text: "unused" };
      }
    } as unknown as SpeechToTextProvider;

    const ttsProvider = {
      describe: () => ({ description: "", displayName: "t", id: "t", local: true, supportedFormats: ["mp3"] }),
      id: "t",
      synthesize: async () => ({ audio: new Uint8Array([1]), format: "mp3" })
    } as unknown as TextToSpeechProvider;

    const helpers: ListenHelpers = {
      apiRequest: async () => ({ content: "unused" }),
      buildVoiceProviders: () => ({ stt: sttProvider, tts: ttsProvider }),
      shells: {
        playAudio: async () => {},
        spawnRec: () => {
          recCalls += 1;
          // The 3rd capture is the next ambient clip AFTER the follow-up
          // failure — reached ONLY if that failure resumed the loop (the
          // fix). Throwing here ends the test cleanly.
          if (recCalls >= 3) throw new Error("sox device gone");
          return fakeRec();
        },
        waitForEnter: async () => {},
        which: (bin: string) => (bin === "sox" ? "/usr/bin/sox" : undefined)
      }
    };

    const program = new Command();
    registerListenCommand(program, io, helpers);
    await program.parseAsync(["node", "muse", "listen", "--wake", "hey muse", "--clip-seconds", "2"]);

    const stderr = stderrChunks.join("");
    // The follow-up STT failure ran through safeTranscribe (resilient),
    // not the old catch that mislabeled it and broke the session.
    expect(stderr).toContain("transcription failed (resuming listen)");
    expect(stderr).not.toContain("sox error during prompt capture");
    // The loop RESUMED: it captured a third ambient clip after the
    // failure. recCalls === 2 would mean the session broke.
    expect(recCalls).toBe(3);
  });
});

describe("muse listen --wake — the core wake-word contract", () => {
  const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
  function fakeRec(): ChildProcess {
    const rec = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: (s?: string) => void };
    rec.stdout = new EventEmitter();
    rec.kill = () => {};
    setImmediate(() => { rec.stdout.emit("data", WAV); rec.emit("close"); });
    return rec as unknown as ChildProcess;
  }
  const ttsProvider = {
    describe: () => ({ description: "", displayName: "t", id: "t", local: true, supportedFormats: ["mp3"] }),
    id: "t",
    synthesize: async () => ({ audio: new Uint8Array([1]), format: "mp3" })
  } as unknown as TextToSpeechProvider;

  it("sends the RESIDUAL (not the wake word) to the agent when the phrase is spoken inline", async () => {
    let recCalls = 0;
    let sttCalls = 0;
    const seen: { message?: unknown } = {};
    const io = { stderr: () => {}, stdout: () => {} };
    const sttProvider = {
      describe: () => ({ description: "", displayName: "s", id: "s", local: true, supportedFormats: ["audio/wav"] }),
      id: "s",
      transcribe: async () => { sttCalls += 1; return { text: "muse what time is it" }; }
    } as unknown as SpeechToTextProvider;
    const helpers: ListenHelpers = {
      apiRequest: async (_io, _cmd, _path, body) => { seen.message = (body ?? {}).message; return { content: "It's 3pm." }; },
      buildVoiceProviders: () => ({ stt: sttProvider, tts: ttsProvider }),
      shells: {
        playAudio: async () => {},
        // capture#1 = the wake clip; the 2nd capture throws to end the loop
        // cleanly after the single wake turn.
        spawnRec: () => { recCalls += 1; if (recCalls >= 2) throw new Error("stop"); return fakeRec(); },
        waitForEnter: async () => {},
        which: (bin: string) => (bin === "sox" ? "/usr/bin/sox" : undefined)
      }
    };
    const program = new Command();
    registerListenCommand(program, io, helpers);
    await program.parseAsync(["node", "muse", "listen", "--wake", "muse", "--clip-seconds", "2"]);
    // Residual reached the agent — the wake word itself is stripped.
    expect(seen.message).toBe("what time is it");
    // No follow-up clip was needed (the residual was inline) → exactly one STT.
    expect(sttCalls).toBe(1);
  });

  it("ignores an utterance that does NOT contain the wake phrase — the agent is never called", async () => {
    let recCalls = 0;
    let chatCalled = false;
    const io = { stderr: () => {}, stdout: () => {} };
    const sttProvider = {
      describe: () => ({ description: "", displayName: "s", id: "s", local: true, supportedFormats: ["audio/wav"] }),
      id: "s",
      transcribe: async () => ({ text: "what time is it" })  // no wake phrase
    } as unknown as SpeechToTextProvider;
    const helpers: ListenHelpers = {
      apiRequest: async () => { chatCalled = true; return { content: "should not reach" }; },
      buildVoiceProviders: () => ({ stt: sttProvider, tts: ttsProvider }),
      shells: {
        playAudio: async () => {},
        // capture#1 = the non-wake clip (ignored → loop continues); capture#2
        // throws to end the loop.
        spawnRec: () => { recCalls += 1; if (recCalls >= 2) throw new Error("stop"); return fakeRec(); },
        waitForEnter: async () => {},
        which: (bin: string) => (bin === "sox" ? "/usr/bin/sox" : undefined)
      }
    };
    const program = new Command();
    registerListenCommand(program, io, helpers);
    await program.parseAsync(["node", "muse", "listen", "--wake", "muse", "--clip-seconds", "2"]);
    expect(chatCalled, "an unaddressed utterance must never reach the agent").toBe(false);
  });
});
