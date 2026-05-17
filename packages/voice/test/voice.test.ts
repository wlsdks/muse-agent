import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  FakeAudioFrameWakeWordDetector,
  FakeLiveVoiceProvider,
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  PiperTtsProvider,
  TextScanWakeWordDetector,
  VoiceProviderError,
  VoiceProviderRegistry,
  VoiceValidationError,
  WhisperCppSttProvider,
  createWhisperCppRunner,
  buildGeminiLiveAudioFrame,
  buildGeminiLiveEndTurnFrame,
  buildGeminiLiveSetupFrame,
  parseGeminiLiveServerFrame,
  type LiveVoiceEvent,
  type PiperRunner,
  type WhisperCppRunner
} from "../src/index.js";

const apiKey = "sk-test";

describe("OpenAIWhisperSttProvider", () => {
  it("requires an api key", () => {
    expect(() => new OpenAIWhisperSttProvider({ apiKey: "", fetchImpl: dummyFetch() })).toThrow(
      VoiceValidationError
    );
  });

  it("describes itself", () => {
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    const info = provider.describe();
    expect(info.id).toBe("openai-whisper");
    expect(info.local).toBe(false);
    expect(info.supportedFormats).toContain("audio/wav");
  });

  it("rejects empty audio", async () => {
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(
      provider.transcribe({ audio: new Uint8Array(0), mimeType: "audio/wav" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("rejects missing mime type", async () => {
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(
      provider.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: "" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("posts multipart form-data with the model and parses the response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
      const body = init.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("model")).toBe("whisper-1");
      expect(body.get("response_format")).toBe("json");
      const file = body.get("file") as Blob;
      expect(file.type).toBe("audio/wav");
      return new Response(
        JSON.stringify({ text: "hello world", language: "en", duration: 1.25 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl });
    const result = await provider.transcribe({
      audio: new Uint8Array([0, 1, 2, 3]),
      mimeType: "audio/wav",
      language: "en"
    });

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.durationMs).toBe(1250);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("wraps non-2xx as VoiceProviderError with HTTP code", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream boom", { status: 503 })
    );
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("HTTP_503");
  });

  it("rejects responses missing the `text` field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("BAD_SHAPE");
  });
});

describe("OpenAITtsProvider", () => {
  it("requires an api key", () => {
    expect(() => new OpenAITtsProvider({ apiKey: "", fetchImpl: dummyFetch() })).toThrow(
      VoiceValidationError
    );
  });

  it("describes itself", () => {
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    const info = provider.describe();
    expect(info.id).toBe("openai-tts");
    expect(info.availableVoices).toContain("alloy");
    expect(info.supportedFormats).toContain("mp3");
  });

  it("rejects empty text", async () => {
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(provider.synthesize({ text: "  " })).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("posts a JSON body with model + voice + format and returns audio bytes", async () => {
    const audio = new Uint8Array([10, 20, 30, 40]);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("nova");
      expect(body.input).toBe("hi there");
      expect(body.response_format).toBe("mp3");
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });

    const provider = new OpenAITtsProvider({ apiKey, fetchImpl });
    const result = await provider.synthesize({ text: "hi there", voice: "nova" });

    expect(result.format).toBe("mp3");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(Array.from(result.audio)).toEqual([10, 20, 30, 40]);
  });

  it("rejects unsupported formats at the provider boundary", async () => {
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(
      provider.synthesize({ text: "x", format: "bogus" as never })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("wraps non-2xx as VoiceProviderError with HTTP code", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("HTTP_401");
  });

  it("rejects empty audio bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 }));
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("EMPTY_BODY");
  });
});

describe("WhisperCppSttProvider", () => {
  it("works with no options (defaults to whisper-cpp binary + ~/.muse/whisper-models/ggml-base.en.bin)", () => {
    const provider = new WhisperCppSttProvider();
    expect(provider.id).toBe("whisper-cpp");
    expect(provider.describe().local).toBe(true);
    expect(provider.describe().supportedFormats).toContain("audio/wav");
  });

  it("rejects empty audio", async () => {
    const provider = new WhisperCppSttProvider({ runner: noopRunner() });
    await expect(
      provider.transcribe({ audio: new Uint8Array(0), mimeType: "audio/wav" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("rejects missing mime type", async () => {
    const provider = new WhisperCppSttProvider({ runner: noopRunner() });
    await expect(
      provider.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: "" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("createWhisperCppRunner SIGKILLs a hung process and rejects (no infinite hang)", async () => {
    const runner = createWhisperCppRunner(120);
    const start = Date.now();
    // A real child that never exits on its own — proves the timeout
    // actually kills it rather than the test just timing out.
    await expect(
      runner(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
    ).rejects.toThrow(/timed out after 120ms and was killed/u);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("createWhisperCppRunner resolves normally for a fast-exiting process", async () => {
    const runner = createWhisperCppRunner(10_000);
    const result = await runner(process.execPath, ["-e", "process.exit(0)"]);
    expect(result.exitCode).toBe(0);
  });

  it("spawns whisper-cpp with the expected argv and returns the txt body", async () => {
    let capturedBinary = "";
    let capturedArgs: readonly string[] = [];
    const runner: WhisperCppRunner = async (binary, args) => {
      capturedBinary = binary;
      capturedArgs = args;
      const ofIndex = args.indexOf("-of");
      const outputPrefix = args[ofIndex + 1];
      if (outputPrefix) {
        await writeFile(`${outputPrefix}.txt`, "  hello there  \n");
      }
      return { exitCode: 0, stderr: "" };
    };
    const provider = new WhisperCppSttProvider({
      binaryPath: "/custom/whisper-cpp",
      modelPath: "/models/ggml-tiny.bin",
      runner
    });
    const result = await provider.transcribe({
      audio: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      language: "ko",
      mimeType: "audio/wav"
    });
    expect(capturedBinary).toBe("/custom/whisper-cpp");
    expect(capturedArgs).toContain("-m");
    expect(capturedArgs).toContain("/models/ggml-tiny.bin");
    expect(capturedArgs).toContain("-nt");
    expect(capturedArgs).toContain("-l");
    expect(capturedArgs).toContain("ko");
    expect(capturedArgs).toContain("-otxt");
    expect(result.text).toBe("hello there");
    expect(result.language).toBe("ko");
  });

  it("defaults language to auto when caller omits it", async () => {
    let capturedArgs: readonly string[] = [];
    const runner: WhisperCppRunner = async (_binary, args) => {
      capturedArgs = args;
      const ofIndex = args.indexOf("-of");
      const outputPrefix = args[ofIndex + 1];
      if (outputPrefix) {
        await writeFile(`${outputPrefix}.txt`, "x");
      }
      return { exitCode: 0, stderr: "" };
    };
    const provider = new WhisperCppSttProvider({ runner });
    await provider.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" });
    const langIndex = capturedArgs.indexOf("-l");
    expect(capturedArgs[langIndex + 1]).toBe("auto");
  });

  it("wraps non-zero exit codes as VoiceProviderError with EXIT_<n>", async () => {
    const runner: WhisperCppRunner = async () => ({ exitCode: 2, stderr: "bad model" });
    const provider = new WhisperCppSttProvider({ runner });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("EXIT_2");
    expect((error as VoiceProviderError).message).toContain("bad model");
  });

  it("wraps a runner-throw as VoiceProviderError SPAWN_FAILED", async () => {
    const runner: WhisperCppRunner = async () => {
      throw new Error("ENOENT whisper-cpp");
    };
    const provider = new WhisperCppSttProvider({ runner });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("SPAWN_FAILED");
  });

  it("surfaces OUTPUT_MISSING when whisper-cpp exits 0 but no .txt was produced", async () => {
    const runner: WhisperCppRunner = async () => ({ exitCode: 0, stderr: "" });
    const provider = new WhisperCppSttProvider({ runner });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("OUTPUT_MISSING");
  });
});

describe("PiperTtsProvider", () => {
  it("requires a modelPath", () => {
    expect(() => new PiperTtsProvider({ modelPath: "", runner: noopPiperRunner() })).toThrow(
      VoiceValidationError
    );
  });

  it("describes itself as local with the model path in the description", () => {
    const provider = new PiperTtsProvider({ modelPath: "/voices/amy.onnx", runner: noopPiperRunner() });
    const info = provider.describe();
    expect(info.id).toBe("piper");
    expect(info.local).toBe(true);
    expect(info.supportedFormats).toEqual(["wav"]);
    expect(info.description).toContain("/voices/amy.onnx");
  });

  it("rejects empty text", async () => {
    const provider = new PiperTtsProvider({ modelPath: "/voices/amy.onnx", runner: noopPiperRunner() });
    await expect(provider.synthesize({ text: "" })).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("rejects non-wav format requests", async () => {
    const provider = new PiperTtsProvider({ modelPath: "/voices/amy.onnx", runner: noopPiperRunner() });
    await expect(
      provider.synthesize({ text: "hello", format: "mp3" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("spawns piper with the expected argv, pipes text on stdin, returns the wav bytes", async () => {
    let capturedBinary = "";
    let capturedArgs: readonly string[] = [];
    let capturedStdin = "";
    const runner: PiperRunner = async (binary, args, stdin) => {
      capturedBinary = binary;
      capturedArgs = args;
      capturedStdin = stdin;
      const fIndex = args.indexOf("-f");
      const outputPath = args[fIndex + 1];
      if (outputPath) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(outputPath, Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]));
      }
      return { exitCode: 0, stderr: "" };
    };
    const provider = new PiperTtsProvider({
      binaryPath: "/custom/piper",
      modelPath: "/voices/amy.onnx",
      runner
    });
    const result = await provider.synthesize({ text: "hello world" });
    expect(capturedBinary).toBe("/custom/piper");
    expect(capturedArgs).toContain("-m");
    expect(capturedArgs).toContain("/voices/amy.onnx");
    expect(capturedArgs).toContain("-f");
    expect(capturedStdin).toBe("hello world");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.format).toBe("wav");
    expect(result.audio.byteLength).toBe(8);
  });

  it("wraps non-zero exit codes as VoiceProviderError with EXIT_<n>", async () => {
    const runner: PiperRunner = async () => ({ exitCode: 3, stderr: "model load failed" });
    const provider = new PiperTtsProvider({ modelPath: "/voices/x.onnx", runner });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("EXIT_3");
    expect((error as VoiceProviderError).message).toContain("model load failed");
  });

  it("surfaces OUTPUT_MISSING when piper exits 0 but no .wav was produced", async () => {
    const runner: PiperRunner = async () => ({ exitCode: 0, stderr: "" });
    const provider = new PiperTtsProvider({ modelPath: "/voices/x.onnx", runner });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("OUTPUT_MISSING");
  });

  it("wraps a runner-throw as VoiceProviderError SPAWN_FAILED", async () => {
    const runner: PiperRunner = async () => {
      throw new Error("ENOENT piper");
    };
    const provider = new PiperTtsProvider({ modelPath: "/voices/x.onnx", runner });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("SPAWN_FAILED");
  });
});

describe("TextScanWakeWordDetector", () => {
  it("rejects an empty phrase", () => {
    expect(() => new TextScanWakeWordDetector({ phrase: "  " })).toThrow();
  });

  it("detects a basic case-insensitive match", () => {
    const detector = new TextScanWakeWordDetector({ phrase: "hey muse" });
    const result = detector.scan("Hey Muse what's the weather?");
    expect(result.detected).toBe(true);
    expect(result.residual).toBe("what's the weather?");
  });

  it("tolerates extra whitespace + punctuation in the input", () => {
    const detector = new TextScanWakeWordDetector({ phrase: "hey muse" });
    const result = detector.scan("Hey,  Muse — open the deploy doc");
    expect(result.detected).toBe(true);
    expect(result.residual).toContain("open the deploy doc");
  });

  it("returns detected without residual when the phrase is at the tail", () => {
    const detector = new TextScanWakeWordDetector({ phrase: "hey muse" });
    const result = detector.scan("Hey muse");
    expect(result).toMatchObject({ detected: true });
    expect(result.residual).toBeUndefined();
  });

  it("returns not-detected when the phrase is absent", () => {
    const detector = new TextScanWakeWordDetector({ phrase: "hey muse" });
    expect(detector.scan("hello there").detected).toBe(false);
  });

  it("matches whole phrases only — never fires inside a longer word (goal 270)", () => {
    const bare = new TextScanWakeWordDetector({ phrase: "hey muse", aliases: ["muse"] });
    // A bare "muse" must NOT trigger on museum / amusement / bemused.
    expect(bare.scan("I visited the museum today").detected).toBe(false);
    expect(bare.scan("that was pure amusement").detected).toBe(false);
    expect(bare.scan("she was bemused by it").detected).toBe(false);
    // …but the wake word as its own token still fires, with residual.
    const ok = bare.scan("muse, what's next?");
    expect(ok.detected).toBe(true);
    expect(ok.residual).toContain("what's next");
    // Multi-word phrase embedded in a longer word ("t[hey muse]ums")
    // no longer false-positives; a real utterance still wakes.
    const hm = new TextScanWakeWordDetector({ phrase: "hey muse" });
    expect(hm.scan("they museums are open").detected).toBe(false);
    expect(hm.scan("hey muse open the door").detected).toBe(true);
  });

  it("handles empty / missing transcripts", () => {
    const detector = new TextScanWakeWordDetector({ phrase: "hey muse" });
    expect(detector.scan("").detected).toBe(false);
    expect(detector.scan("   ").detected).toBe(false);
  });

  it("exposes a describe() with the phrase quoted", () => {
    const detector = new TextScanWakeWordDetector({ phrase: "open sesame" });
    const info = detector.describe();
    expect(info.id).toBe("text-scan");
    expect(info.description).toContain("open sesame");
  });

  it("supports alias phrases — first match wins (goal 121)", () => {
    const detector = new TextScanWakeWordDetector({
      phrase: "hey muse",
      aliases: ["ok muse", "muse please"]
    });

    // Canonical phrase still works.
    expect(detector.scan("Hey Muse what's up").detected).toBe(true);

    // Each alias triggers independently.
    expect(detector.scan("OK muse, schedule the demo").detected).toBe(true);
    expect(detector.scan("OK muse, schedule the demo").residual).toContain("schedule the demo");

    expect(detector.scan("Muse please open the deploy doc").detected).toBe(true);
    expect(detector.scan("Muse please open the deploy doc").residual).toContain("open the deploy doc");

    // None of the alias forms → no detection.
    expect(detector.scan("hello there friend").detected).toBe(false);

    // Empty / whitespace aliases drop silently (not a wake on every input).
    const droppedEmpty = new TextScanWakeWordDetector({
      phrase: "hey muse",
      aliases: ["", "   "]
    });
    expect(droppedEmpty.scan("hello there").detected).toBe(false);

    // describe() lists all phrases for ergonomic surface.
    const info = detector.describe();
    expect(info.description).toContain("hey muse");
    expect(info.description).toContain("ok muse");
    expect(info.description).toContain("muse please");
  });

  it("dedupes aliases that normalise to the same needle (goal 121)", () => {
    const detector = new TextScanWakeWordDetector({
      phrase: "hey muse",
      // Both aliases normalise to "hey muse" — should collapse.
      aliases: ["Hey, Muse!", "  hey   muse  "]
    });
    expect(detector.scan("Hey Muse").detected).toBe(true);
    // describe() still surfaces all spellings (no dedup on display).
    expect(detector.describe().description).toContain("Hey, Muse!");
  });
});

describe("FakeAudioFrameWakeWordDetector", () => {
  it("describes itself with default sampleRate + frameSamples", () => {
    const detector = new FakeAudioFrameWakeWordDetector();
    const info = detector.describe();
    expect(info.id).toBe("fake-audio-wake");
    expect(info.sampleRate).toBe(16_000);
    expect(info.frameSamples).toBe(1_280);
  });

  it("fires on the configured Nth frame and stays quiet otherwise", () => {
    const detector = new FakeAudioFrameWakeWordDetector({ fireOnFrame: 3, fireConfidence: 0.8 });
    const empty = new Int16Array(1_280);
    expect(detector.feedFrame(empty).detected).toBe(false);
    expect(detector.feedFrame(empty).detected).toBe(false);
    const fired = detector.feedFrame(empty);
    expect(fired.detected).toBe(true);
    expect(fired.confidence).toBe(0.8);
    expect(detector.feedFrame(empty).detected).toBe(false);
  });

  it("reset() returns the frame counter to zero", () => {
    const detector = new FakeAudioFrameWakeWordDetector({ fireOnFrame: 2 });
    const empty = new Int16Array(1_280);
    expect(detector.feedFrame(empty).detected).toBe(false);
    expect(detector.feedFrame(empty).detected).toBe(true);
    detector.reset();
    expect(detector.feedFrame(empty).detected).toBe(false);
    expect(detector.feedFrame(empty).detected).toBe(true);
  });
});

describe("Gemini Live protocol", () => {
  it("buildGeminiLiveSetupFrame emits {setup: {model, generationConfig?, systemInstruction?}}", () => {
    const raw = buildGeminiLiveSetupFrame({
      model: "models/gemini-2.0-flash-live-001",
      voice: "Aoede",
      system: "Be terse."
    });
    const parsed = JSON.parse(raw) as { setup: Record<string, unknown> };
    expect(parsed.setup.model).toBe("models/gemini-2.0-flash-live-001");
    const gen = parsed.setup.generationConfig as Record<string, unknown>;
    expect((gen.speechConfig as Record<string, unknown>)).toBeDefined();
    expect((parsed.setup.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text).toBe("Be terse.");
  });

  it("buildGeminiLiveSetupFrame omits generationConfig when no voice / config given", () => {
    const raw = buildGeminiLiveSetupFrame({ model: "models/x" });
    const parsed = JSON.parse(raw) as { setup: Record<string, unknown> };
    expect(parsed.setup.model).toBe("models/x");
    expect(parsed.setup.generationConfig).toBeUndefined();
  });

  it("buildGeminiLiveAudioFrame base64-encodes the audio + sets mimeType", () => {
    const raw = buildGeminiLiveAudioFrame(new Uint8Array([0x01, 0x02, 0x03]), "audio/pcm;rate=16000");
    const parsed = JSON.parse(raw) as {
      realtimeInput: { mediaChunks: Array<{ data: string; mimeType: string }> };
    };
    expect(parsed.realtimeInput.mediaChunks[0]!.mimeType).toBe("audio/pcm;rate=16000");
    expect(parsed.realtimeInput.mediaChunks[0]!.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("buildGeminiLiveEndTurnFrame emits {clientContent: {turnComplete: true}}", () => {
    const raw = buildGeminiLiveEndTurnFrame();
    expect(JSON.parse(raw)).toEqual({ clientContent: { turnComplete: true } });
  });

  it("parseGeminiLiveServerFrame returns text-delta events from modelTurn.parts[].text", () => {
    const events = parseGeminiLiveServerFrame(JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ text: "hello " }, { text: "there" }] }
      }
    }));
    expect(events).toEqual([
      { text: "hello ", type: "text-delta" },
      { text: "there", type: "text-delta" }
    ]);
  });

  it("parseGeminiLiveServerFrame decodes inlineData parts into audio-delta events", () => {
    const audio = Buffer.from([0xAA, 0xBB]);
    const events = parseGeminiLiveServerFrame(JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: audio.toString("base64"), mimeType: "audio/pcm;rate=24000" } }
          ]
        }
      }
    }));
    expect(events).toHaveLength(1);
    const first = events[0];
    expect(first?.type).toBe("audio-delta");
    if (first?.type === "audio-delta") {
      expect(Array.from(first.audio)).toEqual([0xAA, 0xBB]);
      expect(first.mimeType).toBe("audio/pcm;rate=24000");
    }
  });

  it("parseGeminiLiveServerFrame appends a turn-complete event when serverContent.turnComplete is true", () => {
    const events = parseGeminiLiveServerFrame(JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ text: "done" }] },
        turnComplete: true
      }
    }));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "turn-complete" });
  });

  it("parseGeminiLiveServerFrame ignores setupComplete + unknown frames", () => {
    expect(parseGeminiLiveServerFrame(JSON.stringify({ setupComplete: {} }))).toEqual([]);
    expect(parseGeminiLiveServerFrame(JSON.stringify({ unrelated: true }))).toEqual([]);
  });

  it("parseGeminiLiveServerFrame surfaces malformed JSON as an error event", () => {
    const events = parseGeminiLiveServerFrame("not json {");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });
});

describe("FakeLiveVoiceProvider", () => {
  it("describes itself as local with the configured id", () => {
    const provider = new FakeLiveVoiceProvider({ id: "live-test", script: [] });
    const info = provider.describe();
    expect(info.id).toBe("live-test");
    expect(info.local).toBe(true);
  });

  it("captures sendAudio + endTurn calls on the session", async () => {
    const provider = new FakeLiveVoiceProvider({ script: [] });
    const session = await provider.open();
    await session.sendAudio(new Uint8Array([1, 2, 3]));
    await session.sendAudio(new Uint8Array(0)); // empty no-op
    await session.endTurn();
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]!.audioChunks).toHaveLength(1);
    expect(provider.sessions[0]!.endTurns).toBe(1);
  });

  it("emits scripted events through events() until the script ends", async () => {
    const script: readonly LiveVoiceEvent[] = [
      { text: "hello", type: "text-delta" },
      { text: " there", type: "text-delta" },
      { type: "turn-complete" }
    ];
    const provider = new FakeLiveVoiceProvider({ script });
    const session = await provider.open();
    const collected: LiveVoiceEvent[] = [];
    for await (const event of session.events()) {
      collected.push(event);
    }
    expect(collected).toHaveLength(3);
    expect(collected[0]).toMatchObject({ type: "text-delta", text: "hello" });
    expect(collected[2]).toMatchObject({ type: "turn-complete" });
  });

  it("rejects sendAudio / endTurn after close()", async () => {
    const provider = new FakeLiveVoiceProvider({ script: [] });
    const session = await provider.open();
    await session.close();
    await expect(session.sendAudio(new Uint8Array([1]))).rejects.toThrow(/after close/u);
    await expect(session.endTurn()).rejects.toThrow(/after close/u);
  });

  it("close() is idempotent", async () => {
    const provider = new FakeLiveVoiceProvider({ script: [] });
    const session = await provider.open();
    await session.close();
    await session.close(); // should not throw
    expect(provider.sessions[0]!.closed).toBe(true);
  });
});

describe("VoiceProviderRegistry", () => {
  it("registers and looks up providers by id", () => {
    const registry = new VoiceProviderRegistry();
    const stt = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    const tts = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    registry.registerStt(stt);
    registry.registerTts(tts);
    expect(registry.primaryStt()?.id).toBe("openai-whisper");
    expect(registry.primaryTts()?.id).toBe("openai-tts");
    expect(registry.requireStt("openai-whisper")).toBe(stt);
    expect(registry.requireTts("openai-tts")).toBe(tts);
  });

  it("throws for unknown ids", () => {
    const registry = new VoiceProviderRegistry();
    expect(() => registry.requireStt("missing")).toThrow(VoiceProviderError);
    expect(() => registry.requireTts("missing")).toThrow(VoiceProviderError);
  });
});

function dummyFetch(): (input: string, init: RequestInit) => Promise<Response> {
  return async () => new Response("{}", { status: 200 });
}

function noopRunner(): WhisperCppRunner {
  return async () => ({ exitCode: 0, stderr: "" });
}

function noopPiperRunner(): PiperRunner {
  return async () => ({ exitCode: 0, stderr: "" });
}
