/**
 * `muse listen` — Voice Phase C from `docs/design/voice-mode.md`.
 *
 * Push-to-talk voice loop:
 *   (1) verify `sox` is on PATH; exit 1 with install hint if not
 *   (2) spawn `rec -r 16000 -c 1 -t wav -` and capture stdout to
 *       a buffer until the user presses Enter
 *   (3) transcribe via the configured STT provider
 *   (4) POST the transcript to the running API server's /api/chat
 *   (5) synthesize the reply via the configured TTS provider
 *   (6) play the audio through `afplay` (macOS) / `aplay` (Linux)
 *
 * Process boundaries (sox / afplay / aplay) are injected via the
 * `ListenShells` interface so tests can mock the spawns and verify
 * the orchestration logic without needing audio hardware.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform } from "node:process";

import { buildVoiceRegistry } from "@muse/autoconfigure";
import {
  TextScanWakeWordDetector,
  type SpeechToTextProvider,
  type TextToSpeechProvider
} from "@muse/voice";
import type { Command } from "commander";

import { parseBoundedInt } from "./parse-bounded-int.js";
import type { ProgramIO } from "./program.js";
import { parseAudioFormat, resolveAudioPlayerInvocation, synthesizeAndPlay } from "./voice-playback.js";

export interface ListenShells {
  /** Returns the absolute path to a binary on PATH, or undefined when missing. */
  readonly which: (binary: string) => string | undefined;
  /** Spawns `rec` to capture mic input; stdout streams a WAV byte stream. */
  readonly spawnRec: (args: readonly string[]) => ChildProcess;
  /** Spawns the platform's audio player; resolves on exit. */
  readonly playAudio: (filePath: string) => Promise<void>;
  /** Reads a single line from stdin; resolves when the user presses Enter. */
  readonly waitForEnter: () => Promise<void>;
}

export interface ListenHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST"
  ) => Promise<unknown>;
  readonly shells?: ListenShells;
  readonly buildVoiceProviders?: () => {
    readonly stt?: SpeechToTextProvider;
    readonly tts?: TextToSpeechProvider;
  };
}

/**
 * Transcribe one ambient clip without ever throwing into the
 * `while` loop: a transient STT failure (network blip, 5xx,
 * whisper.cpp hiccup) must resume listening, not crash the
 * whole continuous wake session. `undefined` → caller skips
 * this clip. Pure so the resilience contract is unit-testable.
 */
export async function safeTranscribe(
  stt: SpeechToTextProvider,
  request: { readonly audio: Uint8Array; readonly mimeType: string; readonly language?: string },
  io: Pick<ProgramIO, "stderr">
): Promise<string | undefined> {
  try {
    const result = await stt.transcribe(request);
    return result.text.trim();
  } catch (cause) {
    io.stderr(`transcription failed (resuming listen): ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return undefined;
  }
}

export function registerListenCommand(program: Command, io: ProgramIO, helpers: ListenHelpers): void {
  program
    .command("listen")
    .description("Push-to-talk voice loop: speak a prompt, hear the agent reply through the speakers")
    .option("--lang <code>", "Language hint for STT (e.g. 'ko', 'en'). Defaults to autodetect")
    .option("--voice <name>", "TTS voice id (provider-specific, e.g. 'alloy' for OpenAI)")
    .option("--format <type>", "TTS output format: mp3 | wav | opus | aac | flac", "mp3")
    .option("--wake <phrase>", "Voice Phase F.1 ambient mode: listen continuously and trigger on this phrase (e.g. 'hey muse'). Ctrl-C to stop")
    .option("--clip-seconds <seconds>", "Wake-word mode clip length in seconds (default 5)", "5")
    .action(async (options: ListenOptions, command) => {
      const shells = helpers.shells ?? defaultShells();
      const providers = (helpers.buildVoiceProviders ?? defaultBuildVoiceProviders)();
      if (!providers.stt || !providers.tts) {
        io.stderr("voice providers are not configured. Set OPENAI_API_KEY (or MUSE_VOICE_OPENAI_API_KEY) and rebuild.\n");
        command.error("Missing voice providers", { exitCode: 1 });
        return;
      }
      const soxPath = shells.which("sox") ?? shells.which("rec");
      if (!soxPath) {
        io.stderr("sox is not installed. Install: `brew install sox` (macOS) or `apt install sox` (Linux).\n");
        command.error("sox missing", { exitCode: 1 });
        return;
      }

      const runVoiceTurn = async (prompt: string): Promise<void> => {
        io.stdout(`You: ${prompt}\n`);
        const chatResponse = await helpers.apiRequest(io, command, "/api/chat", { message: prompt }, "POST") as {
          readonly content?: string;
        };
        const reply = chatResponse.content?.trim() ?? "(no reply)";
        io.stdout(`Muse: ${reply}\n`);
        await synthesizeAndPlay(
          providers.tts!,
          {
            text: reply,
            ...(options.voice ? { voice: options.voice } : {}),
            ...(options.format ? { format: parseAudioFormat(options.format) } : {})
          },
          shells
        );
      };

      if (options.wake && options.wake.trim().length > 0) {
        const detector = new TextScanWakeWordDetector({ phrase: options.wake.trim() });
        const clipSeconds = parseBoundedInt(options.clipSeconds, "--clip-seconds", 2, 30, 5);
        io.stdout(`Listening for "${options.wake.trim()}"... Ctrl-C to stop.\n`);
        let active = true;
        const onSignal = (): void => {
          active = false;
        };
        process.once("SIGINT", onSignal);
        try {
          while (active) {
            let clipAudio: Buffer;
            try {
              clipAudio = await captureWavForSeconds(shells, clipSeconds);
            } catch (cause) {
              io.stderr(`sox error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
              break;
            }
            if (!active) break;
            if (clipAudio.byteLength === 0) {
              continue;
            }
            const transcript = await safeTranscribe(providers.stt, {
              audio: new Uint8Array(clipAudio),
              mimeType: "audio/wav",
              ...(options.lang ? { language: options.lang } : {})
            }, io);
            if (transcript === undefined || transcript.length === 0) {
              continue;
            }
            const scan = detector.scan(transcript);
            if (!scan.detected) {
              continue;
            }
            // Wake fired. Use residual when present; otherwise capture the next clip.
            let prompt = scan.residual ?? "";
            if (prompt.length === 0) {
              io.stdout(`Wake detected. Listening for prompt (${clipSeconds.toString()}s)...\n`);
              let followAudio: Buffer;
              try {
                followAudio = await captureWavForSeconds(shells, clipSeconds);
              } catch (cause) {
                io.stderr(`sox error during prompt capture: ${cause instanceof Error ? cause.message : String(cause)}\n`);
                break;
              }
              if (followAudio.byteLength === 0) continue;
              // Same resilience contract as the wake-clip transcription:
              // a transient STT failure resumes listening, never breaks
              // the session (a mic/sox failure above still does).
              const followText = await safeTranscribe(providers.stt, {
                audio: new Uint8Array(followAudio),
                mimeType: "audio/wav",
                ...(options.lang ? { language: options.lang } : {})
              }, io);
              if (followText === undefined || followText.length === 0) continue;
              prompt = followText;
            }
            if (prompt.length === 0) {
              io.stderr("Empty prompt after wake; resuming listen.\n");
              continue;
            }
            try {
              await runVoiceTurn(prompt);
            } catch (cause) {
              io.stderr(`voice turn failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            }
            io.stdout(`Listening for "${options.wake.trim()}"...\n`);
          }
        } finally {
          process.off("SIGINT", onSignal);
        }
        return;
      }

      io.stdout("Press Enter to start recording, Enter again to stop.\n");
      await shells.waitForEnter();
      io.stdout("Recording... press Enter to stop.\n");
      let recording: ChildProcess;
      try {
        recording = shells.spawnRec(["-q", "-r", "16000", "-c", "1", "-t", "wav", "-"]);
      } catch (cause) {
        io.stderr(`failed to start sox: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("sox spawn failed", { exitCode: 1 });
        return;
      }
      const chunks: Buffer[] = [];
      recording.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      const stopPromise = new Promise<void>((resolve, reject) => {
        recording.once("error", reject);
        recording.once("close", () => resolve());
      });
      await shells.waitForEnter();
      recording.kill("SIGTERM");
      try {
        await stopPromise;
      } catch (cause) {
        io.stderr(`sox exited with error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("sox failed", { exitCode: 1 });
        return;
      }
      const audio = Buffer.concat(chunks);
      if (audio.byteLength === 0) {
        io.stderr("captured no audio (check microphone permission)\n");
        command.error("empty capture", { exitCode: 1 });
        return;
      }
      io.stdout(`Captured ${audio.byteLength} bytes; transcribing...\n`);
      let stt;
      try {
        stt = await providers.stt.transcribe({
          audio: new Uint8Array(audio),
          mimeType: "audio/wav",
          ...(options.lang ? { language: options.lang } : {})
        });
      } catch (cause) {
        // A failed transcribe (missing whisper model, corrupt audio, a
        // backend hiccup) must end with the same clean one-line error +
        // exit as the sox / empty-capture failures above — not a raw
        // unhandled throw out of the action.
        io.stderr(`transcription failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("transcription failed", { exitCode: 1 });
        return;
      }
      await runVoiceTurn(stt.text);
    });
}

export async function captureWavForSeconds(shells: ListenShells, seconds: number): Promise<Buffer> {
  const recording = shells.spawnRec(["-q", "-r", "16000", "-c", "1", "-t", "wav", "-"]);
  const chunks: Buffer[] = [];
  recording.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const stopPromise = new Promise<void>((resolve, reject) => {
    recording.once("error", reject);
    recording.once("close", () => resolve());
  });
  const timer = setTimeout(() => {
    recording.kill("SIGTERM");
  }, seconds * 1000);
  try {
    await stopPromise;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

interface ListenOptions {
  readonly lang?: string;
  readonly voice?: string;
  readonly format?: string;
  readonly wake?: string;
  readonly clipSeconds?: string;
}

export function defaultShells(): ListenShells {
  return {
    playAudio: (filePath) => new Promise<void>((resolve, reject) => {
      const { cmd, args } = resolveAudioPlayerInvocation(platform, filePath);
      const child = spawn(cmd, [...args], { stdio: ["ignore", "ignore", "pipe"] });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${cmd} exited with code ${code ?? "unknown"}`));
        }
      });
    }),
    spawnRec: (args) => spawn("rec", args, { stdio: ["ignore", "pipe", "pipe"] }),
    waitForEnter: () => new Promise<void>((resolve) => {
      const onData = (): void => {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve();
      };
      process.stdin.resume();
      process.stdin.once("data", onData);
    }),
    which: (binary) => {
      const result = spawnSync(platform === "win32" ? "where" : "which", [binary], { encoding: "utf8" });
      if (result.status !== 0) {
        return undefined;
      }
      const path = result.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0);
      return path?.trim();
    }
  };
}

export function defaultBuildVoiceProviders(): { stt?: SpeechToTextProvider; tts?: TextToSpeechProvider } {
  const registry = buildVoiceRegistry(process.env);
  if (!registry) {
    return {};
  }
  const stt = registry.primaryStt();
  const tts = registry.primaryTts();
  return {
    ...(stt ? { stt } : {}),
    ...(tts ? { tts } : {})
  };
}
