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
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { platform } from "node:process";

import { buildVoiceRegistry } from "@muse/autoconfigure";
import { sleep } from "./async-promises.js";
import { stripUntrustedTerminalChars, truncateErrorBody , asError} from "@muse/shared";
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
  // win32 playback goes through PowerShell's Media.SoundPlayer, which is
  // wav-only — so an unspecified format requests wav there, mp3 elsewhere.
  const synth = await tts.synthesize({
    text: options.text,
    ...(options.voice ? { voice: options.voice } : {}),
    ...(options.format
      ? { format: options.format }
      : platform === "win32" ? { format: "wav" } : {})
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

const STDERR_CAP_CHARS = 4096;
// UTF-8 encodes one code point in at most 4 bytes, so capping raw
// accumulation at 4x the char limit guarantees enough bytes survive to
// decode a full STDERR_CAP_CHARS string without cutting a multi-byte
// sequence mid-character at the truncation boundary.
const STDERR_CAP_BYTES = STDERR_CAP_CHARS * 4;

export interface PlayerInvocation {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function resolveAudioPlayerInvocation(plat: NodeJS.Platform, filePath: string): PlayerInvocation {
  if (plat === "darwin") return { args: [filePath], cmd: "afplay" };
  if (plat === "win32") {
    // SoundPlayer is the only dependency-free synchronous player on a stock
    // Windows box; it is wav-only, which is why synthesizeAndPlay requests
    // wav on win32. Single quotes in a PS single-quoted string escape as ''.
    const escaped = filePath.replace(/'/g, "''");
    return {
      args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`],
      cmd: "powershell"
    };
  }
  return { args: [filePath], cmd: "aplay" };
}

export function playInvocationWithWatchdog(
  invocation: PlayerInvocation,
  spawnFn: typeof spawn = spawn
): Promise<void> {
  return runPlayerWithWatchdog(invocation.cmd, invocation.args, spawnFn);
}

export async function playAudioWithWatchdog(
  player: string,
  filePath: string,
  spawnFn: typeof spawn = spawn
): Promise<void> {
  return runPlayerWithWatchdog(player, [filePath], spawnFn);
}

async function runPlayerWithWatchdog(
  player: string,
  args: readonly string[],
  spawnFn: typeof spawn = spawn
): Promise<void> {
  const child = spawnFn(player, [...args], { stdio: ["ignore", "ignore", "pipe"] });
  // Drain stderr: the pipe must be consumed or a chatty player can wedge once its
  // OS buffer fills, AND the captured text is the only clue when playback fails.
  // Decoding happens once from the full chunks to avoid UTF-8 split corruption.
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < STDERR_CAP_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
  }
  let settled = false;
  const completion = Promise.race([
    once(child, "error").then(([error]) => {
      throw asError(error);
    }),
    once(child, "close").then(([code, signal]) => {
      if (code === 0) return;
      const decoded = Buffer.concat(stderrChunks).toString("utf8");
      const capped = decoded.length > STDERR_CAP_CHARS ? decoded.slice(0, STDERR_CAP_CHARS) : decoded;
      const detail = truncateErrorBody(stripUntrustedTerminalChars(capped).trim(), 240);
      const termination = code === null
        ? `terminated by ${typeof signal === "string" ? signal : "an unknown signal"}`
        : `exited with code ${String(code)}`;
      throw new Error(
        `${player} ${termination}${detail ? `: ${detail}` : ""}`
      );
    })
  ]).finally(() => {
    settled = true;
  });
  const watchdog = sleep(AUDIO_PLAYER_TIMEOUT_MS).then(() => {
    if (settled) return;
    child.kill("SIGKILL");
    throw new Error(`${player} timed out after ${AUDIO_PLAYER_TIMEOUT_MS.toString()}ms and was killed`);
  });
  await Promise.race([completion, watchdog]);
}

function defaultSpeakerShells(): SpeakerShells {
  return {
    playAudio: (filePath) => playInvocationWithWatchdog(resolveAudioPlayerInvocation(platform, filePath))
  };
}
