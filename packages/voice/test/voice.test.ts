import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  PiperTtsProvider,
  TextScanWakeWordDetector,
  VoiceProviderError,
  VoiceProviderRegistry,
  VoiceValidationError,
  WhisperCppSttProvider,
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
