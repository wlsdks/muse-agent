import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { runCommandWithTimeout, withBestEffort } from "@muse/shared";

import { VoiceProviderError, VoiceValidationError } from "./errors.js";
import type {
  TextToSpeechProvider,
  TtsFormat,
  TtsProviderInfo,
  TtsRequest,
  TtsResponse
} from "./types.js";

const SUPPORTED_FORMATS: readonly TtsFormat[] = ["wav"] as const;

/**
 * Result of spawning the Piper binary. The runner is responsible for
 * the spawn lifecycle only — it doesn't read the audio bytes
 * (Piper writes the WAV file to disk, which the provider reads
 * after the runner resolves).
 */
export interface PiperRunResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * Test seam — supply a fake runner to assert the argv Piper receives
 * and to write a synthetic WAV to disk without spawning a real binary.
 * The runner is given the text to synthesize so it can echo it into
 * the output file when an assertion needs to verify the input got
 * piped through stdin.
 */
export type PiperRunner = (
  binary: string,
  args: readonly string[],
  stdin: string
) => Promise<PiperRunResult>;

export interface PiperTtsProviderOptions {
  readonly id?: string;
  /**
   * Path / name of the piper binary. Default `piper` — resolved via
   * PATH at spawn time.
   */
  readonly binaryPath?: string;
  /**
   * Absolute path to the .onnx voice model. Operators bring their
   * own; no lazy-download in this Phase F.3 cut. Choose voices from
   * https://github.com/rhasspy/piper/blob/master/VOICES.md.
   */
  readonly modelPath: string;
  /** Test seam. Defaults to `node:child_process.spawn`. */
  readonly runner?: PiperRunner;
  /**
   * Hard wall-clock cap for a single spawn. A hung piper (stuck
   * ONNX voice load, wedged inference) would otherwise hang the
   * voice-output loop forever — CLAUDE.md: tool loops have
   * explicit timeouts. Default 120 s (covers cold model load).
   * Only applies to the built-in spawn runner; an injected
   * `runner` owns its own lifecycle.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_PIPER_TIMEOUT_MS = 120_000;

/**
 * Local Piper TTS adapter. Spawns `piper -m voice.onnx -f out.wav`,
 * pipes the text in on stdin, reads the resulting WAV.
 *
 * Phase F.3 of `docs/design/voice-mode.md`. Mirrors
 * `OpenAITtsProvider` so the registry can swap between cloud and
 * local TTS without touching the agent or HTTP surfaces. Gemini Live
 * (duplex stream) is a separate provider tracked in the same phase
 * and ships later.
 */
export class PiperTtsProvider implements TextToSpeechProvider {
  readonly id: string;
  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly runner: PiperRunner;

  constructor(options: PiperTtsProviderOptions) {
    if (!options.modelPath) {
      throw new VoiceValidationError("MISSING_MODEL", "Piper TTS requires a modelPath (.onnx voice)");
    }
    this.id = options.id ?? "piper";
    this.binaryPath = options.binaryPath ?? "piper";
    this.modelPath = options.modelPath;
    const timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_PIPER_TIMEOUT_MS;
    this.runner = options.runner ?? createPiperRunner(timeoutMs);
  }

  describe(): TtsProviderInfo {
    return {
      id: this.id,
      displayName: "Piper",
      description: `Local TTS via the piper binary (${this.modelPath})`,
      local: true,
      // Piper voices ARE the model files — no fixed named-voice list
      // to expose. Operators inspect their `~/.muse/piper-voices/`
      // directory or wherever modelPath points.
      availableVoices: [],
      supportedFormats: SUPPORTED_FORMATS
    };
  }

  async synthesize(request: TtsRequest): Promise<TtsResponse> {
    if (!request.text || request.text.trim().length === 0) {
      throw new VoiceValidationError("EMPTY_TEXT", "synthesize() requires non-empty text");
    }
    const format = request.format ?? "wav";
    if (format !== "wav") {
      throw new VoiceValidationError(
        "UNSUPPORTED_FORMAT",
        `Piper produces WAV only (got ${format}); transcode downstream if you need another format`
      );
    }

    const workdir = await mkdtemp(pathJoin(tmpdir(), "muse-piper-"));
    const outputPath = pathJoin(workdir, "out.wav");

    try {
      const args = ["-m", this.modelPath, "-f", outputPath];

      let result: PiperRunResult;
      try {
        result = await this.runner(this.binaryPath, args, request.text);
      } catch (cause) {
        throw new VoiceProviderError(this.id, "SPAWN_FAILED", "piper spawn failed", cause);
      }

      if (result.exitCode !== 0) {
        throw new VoiceProviderError(
          this.id,
          `EXIT_${result.exitCode ?? "NULL"}`,
          `piper exited with ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`
        );
      }

      let audio: Buffer;
      try {
        audio = await readFile(outputPath);
      } catch (cause) {
        throw new VoiceProviderError(this.id, "OUTPUT_MISSING", `piper produced no output file at ${outputPath}`, cause);
      }
      if (audio.byteLength === 0) {
        throw new VoiceProviderError(this.id, "EMPTY_BODY", "piper produced an empty WAV");
      }

      return {
        audio: new Uint8Array(audio),
        mimeType: "audio/wav",
        format: "wav"
      };
    } finally {
      await withBestEffort(rm(workdir, { force: true, recursive: true }), undefined);
    }
  }
}

/**
 * The built-in spawn runner, parameterised by a hard timeout that
 * SIGKILLs a hung piper and rejects, so the voice-output loop
 * fails fast instead of hanging forever. Exported for direct
 * timeout coverage.
 */
export function createPiperRunner(timeoutMs: number = DEFAULT_PIPER_TIMEOUT_MS): PiperRunner {
  return async (binary, args, stdin): Promise<PiperRunResult> => {
    const result = await runCommandWithTimeout({
      command: binary,
      args: [...args],
      timeoutMs,
      maxStderrBytes: 200_000,
      stdin,
      killSignal: "SIGKILL"
    });

    if (result.timedOut) {
      throw new Error(`piper timed out after ${timeoutMs.toString()}ms and was killed`);
    }

    return { exitCode: result.exitCode, stderr: result.stderr };
  };
}
