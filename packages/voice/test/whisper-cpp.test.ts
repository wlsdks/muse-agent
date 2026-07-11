import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceProviderError } from "../src/errors.js";
import {
  LEGACY_ENGLISH_DEFAULT_MODEL_FILE,
  MULTILINGUAL_DEFAULT_MODEL_FILE,
  resetWhisperModelAdvisory,
  resolveDefaultWhisperModelPath,
  WhisperCppSttProvider,
  type WhisperCppRunResult,
  type WhisperCppRunner
} from "../src/whisper-cpp.js";

// Direct coverage for the local whisper.cpp STT adapter (untested module,
// symmetric to the Piper TTS one). The injected `runner` seam drives the whole
// transcribe() path — argv, the input-write + output-txt round-trip, format
// validation, and error-code mapping — with no real whisper-cpp binary.

const audio = new Uint8Array([1, 2, 3, 4]);

// A fake runner that writes `txt` to the `-of <prefix>.txt` output path and
// returns the given exit/stderr; captures the call for assertion.
const fakeRunner = (opts: { txt?: string | null; exitCode?: number; stderr?: string } = {}): WhisperCppRunner & { calls: { binary: string; args: readonly string[] }[] } => {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const runner = (async (binary: string, args: readonly string[]): Promise<WhisperCppRunResult> => {
    calls.push({ args, binary });
    const ofIndex = args.indexOf("-of");
    if (opts.txt !== null && opts.txt !== undefined && ofIndex >= 0) {
      await writeFile(`${args[ofIndex + 1]!}.txt`, opts.txt);
    }
    return { exitCode: opts.exitCode ?? 0, stderr: opts.stderr ?? "" };
  }) as WhisperCppRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
};

describe("WhisperCppSttProvider", () => {
  it("defaults id 'whisper-cpp' and describes itself as local", () => {
    const p = new WhisperCppSttProvider({ modelPath: "/m/base.en.bin", runner: fakeRunner() });
    expect(p.id).toBe("whisper-cpp");
    expect(p.describe()).toMatchObject({ id: "whisper-cpp", local: true });
  });

  it("transcribe: spawns with -f/-m/-otxt/-of, reads the output txt, and returns the TRIMMED text + language", async () => {
    const runner = fakeRunner({ txt: "  hello world  \n" });
    const p = new WhisperCppSttProvider({ binaryPath: "whisper-cpp", modelPath: "/m/base.en.bin", runner });
    const res = await p.transcribe({ audio, language: "en", mimeType: "audio/wav" });
    expect(res).toEqual({ language: "en", text: "hello world" }); // trimmed
    const args = runner.calls[0]!.args;
    expect(args.slice(0, 4)).toEqual(["-f", args[1], "-m", "/m/base.en.bin"]);
    expect(args).toContain("-otxt");
    expect(args[args.indexOf("-l") + 1]).toBe("en"); // language threaded into argv
  });

  it("defaults the language to 'auto' in argv and omits language from the response when not given", async () => {
    const runner = fakeRunner({ txt: "bonjour" });
    const p = new WhisperCppSttProvider({ modelPath: "/m.bin", runner });
    const res = await p.transcribe({ audio, mimeType: "audio/wav" });
    expect(res).toEqual({ text: "bonjour" }); // no language key
    expect(runner.calls[0]!.args[runner.calls[0]!.args.indexOf("-l") + 1]).toBe("auto");
  });

  it("rejects empty audio, missing mimeType, and an unsupported format BEFORE spawning (no runner call)", async () => {
    const runner = fakeRunner();
    const p = new WhisperCppSttProvider({ modelPath: "/m.bin", runner });
    await expect(p.transcribe({ audio: new Uint8Array([]), mimeType: "audio/wav" })).rejects.toMatchObject({ code: "EMPTY_AUDIO" });
    await expect(p.transcribe({ audio, mimeType: "" })).rejects.toMatchObject({ code: "MISSING_MIME_TYPE" });
    await expect(p.transcribe({ audio, mimeType: "audio/x-weird" })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(runner.calls).toHaveLength(0);
  });

  it("accepts a mimeType carrying a ; codecs=… parameter (base type is matched)", async () => {
    const p = new WhisperCppSttProvider({ modelPath: "/m.bin", runner: fakeRunner({ txt: "ok" }) });
    await expect(p.transcribe({ audio, mimeType: "audio/wav; codecs=opus" })).resolves.toMatchObject({ text: "ok" });
  });

  it("maps a thrown runner, a non-zero exit, and a missing output to typed VoiceProviderErrors", async () => {
    const threw = new WhisperCppSttProvider({ modelPath: "/m.bin", runner: (async () => { throw new Error("ENOENT"); }) as WhisperCppRunner });
    await expect(threw.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "SPAWN_FAILED" });

    const exit = new WhisperCppSttProvider({ modelPath: "/m.bin", runner: fakeRunner({ exitCode: 3, stderr: "model missing" }) });
    await expect(exit.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "EXIT_3" });

    const noFile = new WhisperCppSttProvider({ modelPath: "/m.bin", runner: fakeRunner({ txt: null }) }); // exit 0, no txt
    const err = await exit.transcribe({ audio, mimeType: "audio/wav" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceProviderError);
    await expect(noFile.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "OUTPUT_MISSING" });
  });
});

describe("resolveDefaultWhisperModelPath (multilingual default + backward-compat)", () => {
  beforeEach(() => {
    resetWhisperModelAdvisory();
  });

  it("no env + NEITHER file on disk → the MULTILINGUAL default path (no advisory)", () => {
    const warn = vi.fn();
    const resolved = resolveDefaultWhisperModelPath({ exists: () => false, home: "/home/u", warn });
    expect(resolved).toBe(join("/home/u", ".muse", "whisper-models", MULTILINGUAL_DEFAULT_MODEL_FILE));
    expect(resolved.endsWith("ggml-base.bin")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("multilingual present → uses it and IGNORES a legacy .en file", () => {
    const warn = vi.fn();
    const resolved = resolveDefaultWhisperModelPath({
      exists: (p) => p.endsWith(MULTILINGUAL_DEFAULT_MODEL_FILE) || p.endsWith(LEGACY_ENGLISH_DEFAULT_MODEL_FILE),
      home: "/home/u",
      warn
    });
    expect(resolved.endsWith(MULTILINGUAL_DEFAULT_MODEL_FILE)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("only the OLD .en file present → falls back to it + fires the advisory ONCE", () => {
    const warn = vi.fn();
    const onlyLegacy = (p: string): boolean => p.endsWith(LEGACY_ENGLISH_DEFAULT_MODEL_FILE);

    const first = resolveDefaultWhisperModelPath({ exists: onlyLegacy, home: "/home/u", warn });
    expect(first).toBe(join("/home/u", ".muse", "whisper-models", LEGACY_ENGLISH_DEFAULT_MODEL_FILE));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(MULTILINGUAL_DEFAULT_MODEL_FILE); // recommends the multilingual model

    // A second resolve still falls back, but the advisory does NOT repeat.
    const second = resolveDefaultWhisperModelPath({ exists: onlyLegacy, home: "/home/u", warn });
    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1); // still once
  });

  it("an explicit modelPath option ALWAYS wins over the default resolver", () => {
    const provider = new WhisperCppSttProvider({ modelPath: "/custom/my-model.bin", runner: fakeRunner() });
    expect(provider.describe().description).toContain("/custom/my-model.bin");
  });
});
