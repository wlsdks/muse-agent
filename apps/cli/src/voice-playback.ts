/**
 * Shared TTS-and-play helper. Originally inlined in `commands-listen.ts`;
 * extracted so `muse today --brief --speak` (and any future surface that
 * wants to render text through speakers) can reuse the same flow without
 * duplicating the synth → tmp file → afplay/aplay sequence.
 *
 * The shells abstraction (`SpeakerShells`) lets tests inject a fake
 * player so unit tests don't need real audio hardware. Default shells
 * use `afplay` on macOS and `aplay` on Linux, matching `muse listen`.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { platform } from "node:process";

import { buildVoiceRegistry } from "@muse/autoconfigure";
import { stripUntrustedTerminalChars, truncateErrorBody } from "@muse/shared";
import type { TextToSpeechProvider } from "@muse/voice";

import { closestCommandName } from "./closest-command.js";

export const AUDIO_FORMATS = ["mp3", "wav", "opus", "aac", "flac"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export interface SpeakerShells {
  readonly playAudio: (filePath: string) => Promise<void>;
}

export interface SynthesizeAndPlayOptions {
  readonly text: string;
  readonly voice?: string;
  readonly format?: AudioFormat;
}

export async function synthesizeAndPlay(
  tts: TextToSpeechProvider,
  options: SynthesizeAndPlayOptions,
  shells: SpeakerShells = defaultSpeakerShells()
): Promise<void> {
  const synth = await tts.synthesize({
    text: options.text,
    ...(options.voice ? { voice: options.voice } : {}),
    ...(options.format ? { format: options.format } : {})
  });
  const dir = mkdtempSync(pathJoin(tmpdir(), "muse-speak-"));
  try {
    const file = pathJoin(dir, `out.${synth.format}`);
    writeFileSync(file, synth.audio);
    await shells.playAudio(file);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Resolve an audio-format string. Absent / empty → the "mp3"
 * default (legitimate: most callers omit it). An explicitly
 * supplied but unrecognised value throws with a closest-match
 * hint instead of silently coercing to mp3 — a user who asked
 * for "wave" must not silently get "mp3".
 */
export function parseAudioFormat(raw: string | undefined): AudioFormat {
  if (raw === undefined || raw.trim().length === 0) {
    return "mp3";
  }
  const trimmed = raw.trim().toLowerCase();
  if ((AUDIO_FORMATS as readonly string[]).includes(trimmed)) {
    return trimmed as AudioFormat;
  }
  const suggestion = closestCommandName(trimmed, AUDIO_FORMATS);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(
    `invalid audio format '${raw}'${hint} (valid: ${AUDIO_FORMATS.join(", ")})`
  );
}

/**
 * Build the default voice registry from the current `process.env` and
 * return its primary TTS (or `undefined` when no provider is configured).
 * Lets callers fall back to "no audio" gracefully when the user hasn't
 * set OPENAI_API_KEY yet.
 */
export function loadDefaultTts(): TextToSpeechProvider | undefined {
  const registry = buildVoiceRegistry(process.env);
  return registry?.primaryTts();
}

export const AUDIO_PLAYER_TIMEOUT_MS = 30_000;

export async function playAudioWithWatchdog(
  player: string,
  filePath: string,
  spawnFn: typeof spawn = spawn
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(player, [filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Drain stderr: the pipe must be consumed or a chatty player
    // can wedge once its OS buffer fills, AND the captured text is
    // the only clue WHY playback failed ("No such device") — without
    // it the user sees a bare exit code. Bounded so a pathological
    // player can't grow this without limit.
    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
    }
    // Without this watchdog a wedged player — a busy CoreAudio /
    // ALSA device, a stuck process — hangs the calling command
    // (`muse today --speak`, etc.) forever with no recovery.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(
        `${player} timed out after ${AUDIO_PLAYER_TIMEOUT_MS.toString()}ms and was killed`
      )));
    }, AUDIO_PLAYER_TIMEOUT_MS);
    child.once("error", (error) => { finish(() => reject(error)); });
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = truncateErrorBody(stripUntrustedTerminalChars(stderr).trim(), 240);
        reject(new Error(
          `${player} exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`
        ));
      });
    });
  });
}

function defaultSpeakerShells(): SpeakerShells {
  return {
    playAudio: (filePath) => playAudioWithWatchdog(platform === "darwin" ? "afplay" : "aplay", filePath)
  };
}
