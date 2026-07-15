import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { runCommandWithTimeout } from "@muse/shared";

import { VoiceProviderError, VoiceValidationError } from "./errors.js";
import type {
  SpeechToTextProvider,
  SttProviderInfo,
  SttRequest,
  SttResponse
} from "./types.js";

const SUPPORTED_FORMATS = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/flac"
] as const;

/**
 * Result of spawning `whisper-cpp`. The runner is responsible for the
 * spawn lifecycle only — it doesn't read the transcribed text out
 * (whisper-cpp writes `<-of>.txt` to disk, which the provider reads
 * after the runner resolves).
 */
export interface WhisperCppRunResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * Test seam — supply a fake runner to assert against the argv whisper
 * receives and to write a synthetic output txt to disk without spawning
 * a real binary.
 */
export type WhisperCppRunner = (binary: string, args: readonly string[]) => Promise<WhisperCppRunResult>;

export interface WhisperCppSttProviderOptions {
  readonly id?: string;
  /**
   * Path / name of the whisper-cpp binary. Default `whisper-cpp` —
   * resolved via PATH at spawn time. Override with
   * `MUSE_WHISPER_CPP_PATH` upstream when the binary lives elsewhere
   * (e.g. a homebrew formula or a built-from-source artifact).
   */
  readonly binaryPath?: string;
  /**
   * Absolute path to the GGML model file. Default resolves to the
   * MULTILINGUAL `~/.muse/whisper-models/ggml-base.bin` (99 languages
   * incl. Korean; `-l auto` detects the spoken language). For
   * backward-compat, if that file is absent but the legacy
   * English-only `ggml-base.en.bin` exists, the default falls back to
   * it (fail-soft, with a one-time stderr advisory) so an existing
   * install keeps working. Operators bring their own model — Phase F
   * does NOT lazy-download. `MUSE_WHISPER_CPP_MODEL` (registry) always
   * wins over this default.
   */
  readonly modelPath?: string;
  /** Test seam. Defaults to `node:child_process.spawn`. */
  readonly runner?: WhisperCppRunner;
  /**
   * Hard wall-clock cap for a single spawn. A hung whisper-cpp
   * (stuck model load, wedged ffmpeg decode) would otherwise hang
   * the voice loop forever — CLAUDE.md: tool loops have explicit
   * timeouts. Default 120 s (generous: covers cold model load).
   * Only applies to the built-in spawn runner; an injected
   * `runner` owns its own lifecycle.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_WHISPER_TIMEOUT_MS = 120_000;

/**
 * Local Whisper.cpp adapter. Drops a tmp WAV next to a tmp output
 * prefix, spawns `whisper-cpp -f input -m model -nt -l auto -otxt
 * -of out`, then reads `out.txt`. ~3-10 s first call (model load),
 * ~1-2 s subsequent.
 *
 * Phase F.2 of `docs/design/voice-mode.md`. Mirrors
 * `OpenAIWhisperSttProvider` so the registry can swap between cloud
 * and local STT without touching the agent or HTTP surfaces.
 */
export class WhisperCppSttProvider implements SpeechToTextProvider {
  readonly id: string;
  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly runner: WhisperCppRunner;

  constructor(options: WhisperCppSttProviderOptions = {}) {
    this.id = options.id ?? "whisper-cpp";
    this.binaryPath = options.binaryPath ?? "whisper-cpp";
    this.modelPath = options.modelPath ?? resolveDefaultWhisperModelPath();
    const timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_WHISPER_TIMEOUT_MS;
    this.runner = options.runner ?? createWhisperCppRunner(timeoutMs);
  }

  describe(): SttProviderInfo {
    return {
      id: this.id,
      displayName: "Whisper.cpp",
      description: `Local STT via the whisper-cpp binary (${this.modelPath})`,
      local: true,
      supportedFormats: SUPPORTED_FORMATS
    };
  }

  async transcribe(request: SttRequest): Promise<SttResponse> {
    if (!request.audio || request.audio.byteLength === 0) {
      throw new VoiceValidationError("EMPTY_AUDIO", "transcribe() requires non-empty audio bytes");
    }
    if (!request.mimeType) {
      throw new VoiceValidationError("MISSING_MIME_TYPE", "transcribe() requires mimeType");
    }
    // Enforce the advertised `describe().supportedFormats` rather
    // than silently writing an unknown container as `.wav` and
    // letting whisper-cpp fail with a cryptic exit code. Strip any
    // `; codecs=…` parameter before matching.
    const baseMime = request.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!SUPPORTED_FORMATS.includes(baseMime as (typeof SUPPORTED_FORMATS)[number])) {
      throw new VoiceValidationError(
        "UNSUPPORTED_FORMAT",
        `unsupported audio format "${request.mimeType}"; supported: ${SUPPORTED_FORMATS.join(", ")}`
      );
    }

    const workdir = await mkdtemp(pathJoin(tmpdir(), "muse-whisper-"));
    const inputExt = extensionForMime(request.mimeType);
    const inputPath = pathJoin(workdir, `input.${inputExt}`);
    const outputPrefix = pathJoin(workdir, "out");
    const outputTxt = `${outputPrefix}.txt`;

    try {
      await writeFile(inputPath, request.audio);

      const args = [
        "-f", inputPath,
        "-m", this.modelPath,
        "-nt",
        "-l", request.language ?? "auto",
        "-otxt",
        "-of", outputPrefix
      ];

      let result: WhisperCppRunResult;
      try {
        result = await this.runner(this.binaryPath, args);
      } catch (cause) {
        throw new VoiceProviderError(this.id, "SPAWN_FAILED", "whisper-cpp spawn failed", cause);
      }

      if (result.exitCode !== 0) {
        throw new VoiceProviderError(
          this.id,
          `EXIT_${result.exitCode ?? "NULL"}`,
          `whisper-cpp exited with ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`
        );
      }

      let text: string;
      try {
        text = await readFile(outputTxt, "utf8");
      } catch (cause) {
        throw new VoiceProviderError(this.id, "OUTPUT_MISSING", `whisper-cpp produced no output file at ${outputTxt}`, cause);
      }

      return {
        text: text.trim(),
        ...(request.language ? { language: request.language } : {})
      };
    } finally {
      // Best-effort cleanup. Don't mask a transcription error with a
      // disk-cleanup error.
      await rm(workdir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

/**
 * Filename of the shipped default whisper model — the MULTILINGUAL
 * `ggml-base` (99 languages incl. Korean), same size class as the old
 * English-only build. `-l auto` detects the spoken language.
 */
export const MULTILINGUAL_DEFAULT_MODEL_FILE = "ggml-base.bin";
/** The pre-multilingual default — English-ONLY, kept only for fallback. */
export const LEGACY_ENGLISH_DEFAULT_MODEL_FILE = "ggml-base.en.bin";

export interface ResolveWhisperModelDeps {
  /** Existence probe (default `existsSync`). Injectable for tests. */
  readonly exists?: (path: string) => boolean;
  /** Advisory sink for the fallback note (default one-shot stderr). */
  readonly warn?: (message: string) => void;
  /** Home directory (default `os.homedir()`). Injectable for tests. */
  readonly home?: string;
}

let englishFallbackAdvisoryFired = false;

/** Test seam — clears the one-time fallback-advisory latch. */
export function resetWhisperModelAdvisory(): void {
  englishFallbackAdvisoryFired = false;
}

/**
 * Resolve the default whisper model path. Prefers the multilingual
 * `ggml-base.bin`; only if it's absent AND the legacy English-only
 * `ggml-base.en.bin` is present on disk does it fall back to the old
 * file (so a user who downloaded the old default before this change
 * isn't silently broken), emitting a one-time stderr note recommending
 * the multilingual model. When neither exists it returns the
 * multilingual path — the one the setup guidance tells you to download.
 */
export function resolveDefaultWhisperModelPath(deps: ResolveWhisperModelDeps = {}): string {
  const home = deps.home ?? homedir();
  const dir = pathJoin(home, ".muse", "whisper-models");
  const multilingual = pathJoin(dir, MULTILINGUAL_DEFAULT_MODEL_FILE);
  const legacyEnglish = pathJoin(dir, LEGACY_ENGLISH_DEFAULT_MODEL_FILE);
  const exists = deps.exists ?? existsSync;

  if (exists(multilingual)) {
    return multilingual;
  }
  if (exists(legacyEnglish)) {
    if (!englishFallbackAdvisoryFired) {
      englishFallbackAdvisoryFired = true;
      const message =
        `[muse voice] whisper default: multilingual ${MULTILINGUAL_DEFAULT_MODEL_FILE} not found; ` +
        `using the English-ONLY ${LEGACY_ENGLISH_DEFAULT_MODEL_FILE} already on disk. ` +
        `Korean (and other non-English) speech will NOT transcribe. To fix, download the multilingual model: ` +
        `curl -L -o ${multilingual} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MULTILINGUAL_DEFAULT_MODEL_FILE}`;
      (deps.warn ?? ((m: string) => process.stderr.write(`${m}\n`)))(message);
    }
    return legacyEnglish;
  }
  return multilingual;
}

function extensionForMime(mime: string): string {
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("flac")) return "flac";
  return "wav";
}

/**
 * The built-in spawn runner, parameterised by a hard timeout that
 * SIGKILLs a hung whisper-cpp and rejects, so the voice loop fails
 * fast instead of hanging forever. Exported for direct timeout
 * coverage.
 */
export function createWhisperCppRunner(timeoutMs: number = DEFAULT_WHISPER_TIMEOUT_MS): WhisperCppRunner {
  return async (binary, args): Promise<WhisperCppRunResult> => {
    const result = await runCommandWithTimeout({
      command: binary,
      args: [...args],
      timeoutMs,
      maxStderrBytes: 200_000,
      killSignal: "SIGKILL"
    });

    if (result.timedOut) {
      throw new Error(`whisper-cpp timed out after ${timeoutMs.toString()}ms and was killed`);
    }

    return { exitCode: result.exitCode, stderr: result.stderr };
  };
}
