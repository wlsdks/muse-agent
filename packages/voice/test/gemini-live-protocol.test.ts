import { describe, expect, it } from "vitest";

import {
  buildGeminiLiveAudioFrame,
  buildGeminiLiveEndTurnFrame,
  buildGeminiLiveSetupFrame,
  parseGeminiLiveServerFrame
} from "../src/gemini-live-protocol.js";

const parse = (frame: unknown) => parseGeminiLiveServerFrame(typeof frame === "string" ? frame : JSON.stringify(frame));

describe("buildGeminiLiveSetupFrame", () => {
  it("emits a minimal setup frame with just the model", () => {
    expect(JSON.parse(buildGeminiLiveSetupFrame({ model: "models/gemini-live" }))).toEqual({
      setup: { model: "models/gemini-live" }
    });
  });

  it("adds audio response modality + speech config when a voice is given", () => {
    const setup = JSON.parse(buildGeminiLiveSetupFrame({ model: "m", voice: "Charon" })).setup;
    expect(setup.generationConfig).toEqual({
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
    });
  });

  it("merges a caller generationConfig under the voice config (voice fields win on conflict)", () => {
    const setup = JSON.parse(buildGeminiLiveSetupFrame({ generationConfig: { temperature: 0.5 }, model: "m", voice: "Aoede" })).setup;
    expect(setup.generationConfig.temperature).toBe(0.5);
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Aoede");
  });

  it("passes a generationConfig through untouched when no voice is set", () => {
    const setup = JSON.parse(buildGeminiLiveSetupFrame({ generationConfig: { topK: 3 }, model: "m" })).setup;
    expect(setup.generationConfig).toEqual({ topK: 3 });
  });

  it("attaches a system instruction when a system prompt is given", () => {
    const setup = JSON.parse(buildGeminiLiveSetupFrame({ model: "m", system: "be brief" })).setup;
    expect(setup.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
  });

  it("omits generationConfig and systemInstruction when neither voice/config/system is present", () => {
    const setup = JSON.parse(buildGeminiLiveSetupFrame({ model: "m" })).setup;
    expect(setup).not.toHaveProperty("generationConfig");
    expect(setup).not.toHaveProperty("systemInstruction");
  });
});

describe("buildGeminiLiveAudioFrame", () => {
  it("base64-encodes the audio bytes into a realtimeInput mediaChunk", () => {
    const frame = JSON.parse(buildGeminiLiveAudioFrame(new Uint8Array([1, 2, 3, 4]), "audio/pcm;rate=16000"));
    expect(frame).toEqual({
      realtimeInput: { mediaChunks: [{ data: "AQIDBA==", mimeType: "audio/pcm;rate=16000" }] }
    });
  });

  it("encodes an empty buffer to an empty string", () => {
    const frame = JSON.parse(buildGeminiLiveAudioFrame(new Uint8Array([]), "audio/pcm"));
    expect(frame.realtimeInput.mediaChunks[0].data).toBe("");
  });
});

describe("buildGeminiLiveEndTurnFrame", () => {
  it("emits a clientContent turnComplete signal", () => {
    expect(JSON.parse(buildGeminiLiveEndTurnFrame())).toEqual({ clientContent: { turnComplete: true } });
  });
});

describe("parseGeminiLiveServerFrame", () => {
  it("surfaces malformed JSON as an error event rather than throwing", () => {
    const events = parse("{not valid json");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { error: Error }).error).toBeInstanceOf(Error);
  });

  it("returns nothing for a non-record top-level frame", () => {
    expect(parse("[]")).toEqual([]);
    expect(parse("42")).toEqual([]);
    expect(parse('"string"')).toEqual([]);
  });

  it("treats setupComplete as a no-event acknowledgement", () => {
    expect(parse({ setupComplete: {} })).toEqual([]);
  });

  it("returns nothing when there is no serverContent", () => {
    expect(parse({ somethingElse: 1 })).toEqual([]);
  });

  it("emits a text-delta for a model text part", () => {
    expect(parse({ serverContent: { modelTurn: { parts: [{ text: "hello" }] } } })).toEqual([
      { text: "hello", type: "text-delta" }
    ]);
  });

  it("skips an empty text part", () => {
    expect(parse({ serverContent: { modelTurn: { parts: [{ text: "" }] } } })).toEqual([]);
  });

  it("decodes an inlineData audio part into an audio-delta", () => {
    const events = parse({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from([9, 8, 7]).toString("base64"), mimeType: "audio/pcm;rate=24000" } }] } }
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("audio-delta");
    const audio = events[0] as { audio: Uint8Array; mimeType: string };
    expect(Array.from(audio.audio)).toEqual([9, 8, 7]);
    expect(audio.mimeType).toBe("audio/pcm;rate=24000");
  });

  it("emits text, audio, and turn-complete from one combined frame in order", () => {
    const events = parse({
      serverContent: {
        modelTurn: { parts: [{ text: "hi" }, { inlineData: { data: Buffer.from([1]).toString("base64"), mimeType: "audio/pcm" } }] },
        turnComplete: true
      }
    });
    expect(events.map((e) => e.type)).toEqual(["text-delta", "audio-delta", "turn-complete"]);
  });

  it("skips non-record parts and parts that are not an array", () => {
    expect(parse({ serverContent: { modelTurn: { parts: ["x", null, { text: "ok" }] } } })).toEqual([
      { text: "ok", type: "text-delta" }
    ]);
    expect(parse({ serverContent: { modelTurn: { parts: "nope" } } })).toEqual([]);
  });

  it("skips an inlineData part missing its mimeType", () => {
    expect(parse({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAA" } }] } } })).toEqual([]);
  });

  it("maps both turnComplete and interrupted to a turn-complete event", () => {
    expect(parse({ serverContent: { turnComplete: true } })).toEqual([{ type: "turn-complete" }]);
    expect(parse({ serverContent: { interrupted: true } })).toEqual([{ type: "turn-complete" }]);
  });

  // Buffer.from(_, "base64") is lenient — it never throws on bad input, so the
  // audio-delta path still produces bytes (the inner catch is defensive, not
  // reachable through a malformed-base64 frame). Lock that real behavior.
  it("still decodes a malformed-base64 audio chunk (Buffer is lenient)", () => {
    const events = parse({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "!!!not-base64!!!", mimeType: "audio/pcm" } }] } } });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("audio-delta");
  });
});
