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
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { platform } from "node:process";

import { buildVoiceRegistry } from "@muse/autoconfigure";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider
} from "@muse/voice";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

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

export function registerListenCommand(program: Command, io: ProgramIO, helpers: ListenHelpers): void {
  program
    .command("listen")
    .description("Push-to-talk voice loop: speak a prompt, hear the agent reply through the speakers")
    .option("--lang <code>", "Language hint for STT (e.g. 'ko', 'en'). Defaults to autodetect")
    .option("--voice <name>", "TTS voice id (provider-specific, e.g. 'alloy' for OpenAI)")
    .option("--format <type>", "TTS output format: mp3 | wav | opus | aac | flac", "mp3")
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
      const stt = await providers.stt.transcribe({
        audio: new Uint8Array(audio),
        mimeType: "audio/wav",
        ...(options.lang ? { language: options.lang } : {})
      });
      io.stdout(`You: ${stt.text}\n`);
      const chatResponse = await helpers.apiRequest(io, command, "/api/chat", { message: stt.text }, "POST") as {
        readonly content?: string;
      };
      const reply = chatResponse.content?.trim() ?? "(no reply)";
      io.stdout(`Muse: ${reply}\n`);
      const tts = await providers.tts.synthesize({
        text: reply,
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.format ? { format: parseFormat(options.format) } : {})
      });
      const dir = mkdtempSync(pathJoin(tmpdir(), "muse-listen-"));
      const audioFile = pathJoin(dir, `reply.${tts.format}`);
      writeFileSync(audioFile, tts.audio);
      try {
        await shells.playAudio(audioFile);
      } finally {
        try {
          unlinkSync(audioFile);
        } catch {
          // best-effort cleanup
        }
      }
    });
}

interface ListenOptions {
  readonly lang?: string;
  readonly voice?: string;
  readonly format?: string;
}

function parseFormat(raw: string): "mp3" | "wav" | "opus" | "aac" | "flac" {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "mp3" || trimmed === "wav" || trimmed === "opus" || trimmed === "aac" || trimmed === "flac") {
    return trimmed;
  }
  return "mp3";
}

function defaultShells(): ListenShells {
  return {
    playAudio: (filePath) => new Promise<void>((resolve, reject) => {
      const player = platform === "darwin" ? "afplay" : "aplay";
      const child = spawn(player, [filePath], { stdio: ["ignore", "ignore", "pipe"] });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${player} exited with code ${code ?? "unknown"}`));
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

function defaultBuildVoiceProviders(): { stt?: SpeechToTextProvider; tts?: TextToSpeechProvider } {
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
