import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

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
   * Absolute path to the GGML model file. Default
   * `~/.muse/whisper-models/ggml-base.en.bin`. Operators bring their
   * own model — Phase F first cut does NOT lazy-download. A future
   * pass can wire `MUSE_WHISPER_CPP_MODEL_URL` into a one-shot
   * download on `whisper-cpp setup`.
   */
  readonly modelPath?: string;
  /** Test seam. Defaults to `node:child_process.spawn`. */
  readonly runner?: WhisperCppRunner;
}

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
    this.modelPath = options.modelPath ?? defaultModelPath();
    this.runner = options.runner ?? defaultRunner;
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

function defaultModelPath(): string {
  return pathJoin(homedir(), ".muse", "whisper-models", "ggml-base.en.bin");
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

async function defaultRunner(binary: string, args: readonly string[]): Promise<WhisperCppRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr });
    });
  });
}

