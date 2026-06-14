import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_FORMATS,
  AUDIO_PLAYER_TIMEOUT_MS,
  parseAudioFormat,
  playAudioWithWatchdog,
  synthesizeAndPlay,
  type SpeakerShells
} from "./voice-playback.js";

interface FakeChild extends EventEmitter {
  kill: (signal?: string) => boolean;
  killedWith?: string;
  stderr: EventEmitter;
}

function makeFakeSpawn(): { spawnFn: typeof spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.kill = (signal?: string): boolean => {
    child.killedWith = signal ?? "SIGTERM";
    return true;
  };
  const spawnFn = (() => child) as unknown as typeof spawn;
  return { child, spawnFn };
}

describe("parseAudioFormat", () => {
  it("defaults to mp3 when omitted or blank (the legitimate default)", () => {
    expect(parseAudioFormat(undefined)).toBe("mp3");
    expect(parseAudioFormat("")).toBe("mp3");
    expect(parseAudioFormat("   ")).toBe("mp3");
  });

  it("accepts every valid format, case- and whitespace-insensitive", () => {
    for (const fmt of AUDIO_FORMATS) {
      expect(parseAudioFormat(fmt)).toBe(fmt);
      expect(parseAudioFormat(`  ${fmt.toUpperCase()}  `)).toBe(fmt);
    }
  });

  it("throws with a closest-match hint on a typo (no silent mp3 fallback)", () => {
    expect(() => parseAudioFormat("wave")).toThrow(/invalid audio format 'wave'/u);
    expect(() => parseAudioFormat("wave")).toThrow(/did you mean 'wav'/u);
    expect(() => parseAudioFormat("mp4")).toThrow(/did you mean 'mp3'/u);
  });

  it("throws (still) when no candidate is close enough, listing valid values", () => {
    expect(() => parseAudioFormat("zzzzz")).toThrow(/valid: mp3, wav, opus, aac, flac/u);
    expect(() => parseAudioFormat("zzzzz")).not.toThrow(/did you mean/u);
  });
});

describe("playAudioWithWatchdog (shared --speak player watchdog)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the player exits 0", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioWithWatchdog("afplay", "/tmp/out.mp3", spawnFn);
    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the exit code on a non-zero exit", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioWithWatchdog("aplay", "/tmp/out.wav", spawnFn);
    child.emit("close", 4);
    await expect(promise).rejects.toThrow(/aplay exited with code 4/u);
  });

  it("includes the player's stderr in the failure so the user sees WHY playback failed, sanitised", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioWithWatchdog("aplay", "/tmp/out.wav", spawnFn);
    // A real ALSA failure writes the reason to stderr; include an
    // ESC byte to prove the message is terminal-sanitised on the way out.
    child.stderr.emit("data", Buffer.from("ALSA lib: \x1b[31mNo such device\x1b[0m\n"));
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(/aplay exited with code 1: ALSA lib: \[31mNo such device/u);
    await expect(promise).rejects.not.toThrow(/\x1b/u);
  });

  it("rejects on a spawn error (player not installed)", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioWithWatchdog("afplay", "/tmp/out.mp3", spawnFn);
    child.emit("error", new Error("ENOENT afplay"));
    await expect(promise).rejects.toThrow(/ENOENT afplay/u);
  });

  it("SIGKILLs and rejects when the player wedges past the timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioWithWatchdog("afplay", "/tmp/out.mp3", spawnFn);
    const assertion = expect(promise).rejects.toThrow(/afplay timed out after 30000ms and was killed/u);
    await vi.advanceTimersByTimeAsync(AUDIO_PLAYER_TIMEOUT_MS);
    await assertion;
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("does not double-settle: a late close after the timeout is ignored", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioWithWatchdog("afplay", "/tmp/out.mp3", spawnFn);
    const assertion = expect(promise).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(AUDIO_PLAYER_TIMEOUT_MS);
    child.emit("close", 0);
    await assertion;
  });
});

describe("synthesizeAndPlay — `mkdtemp` cleanup so a long-running `muse listen` / `muse today --brief --speak` daemon can't leak an empty /tmp/muse-speak-XXXX directory on every TTS play (pre-fix only the file inside was unlinked; the directory itself stayed forever)", () => {
  // synthesizeAndPlay calls `mkdtempSync(join(os.tmpdir(), "muse-speak-"))`,
  // and os.tmpdir() reads $TMPDIR on each call. Point it at a private dir
  // per test so the before/after diff sees ONLY this test's directories —
  // never a muse-speak-* created concurrently by another worker in the
  // shared /tmp (the prior version diffed the real shared tmp and timed
  // out / false-leaked under parallel load).
  let isolatedTmp: string;
  let savedTmpdir: string | undefined;

  beforeEach(() => {
    isolatedTmp = mkdtempSync(pathJoin(tmpdir(), "muse-speak-test-root-"));
    savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
  });

  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    rmSync(isolatedTmp, { recursive: true, force: true });
  });

  async function listMuseSpeakTmpDirs(): Promise<readonly string[]> {
    try {
      const entries = await readdir(isolatedTmp);
      return entries.filter((name) => name.startsWith("muse-speak-")).sort();
    } catch {
      return [];
    }
  }

  const fakeTts = {
    id: "fake-tts",
    describe: () => ({
      id: "fake-tts",
      displayName: "Fake",
      description: "",
      local: true,
      availableVoices: [],
      supportedFormats: ["mp3" as const]
    }),
    synthesize: () => Promise.resolve({
      audio: new Uint8Array([0x49, 0x44, 0x33]),
      mimeType: "audio/mpeg",
      format: "mp3" as const
    })
  };

  it("removes the whole mkdtemp dir (not just the audio file) after a successful play, so the post-call tmp tree carries no new muse-speak-* entries", async () => {
    const before = await listMuseSpeakTmpDirs();
    const shells: SpeakerShells = { playAudio: () => Promise.resolve() };
    await synthesizeAndPlay(fakeTts, { text: "hello" }, shells);
    const after = await listMuseSpeakTmpDirs();
    const leaked = after.filter((d) => !before.includes(d));
    expect(leaked).toEqual([]);
  });

  it("removes the mkdtemp dir EVEN when playAudio throws — finally cleanup must not leak on the error path", async () => {
    const before = await listMuseSpeakTmpDirs();
    const shells: SpeakerShells = { playAudio: () => Promise.reject(new Error("player wedged")) };
    await expect(synthesizeAndPlay(fakeTts, { text: "hello" }, shells)).rejects.toThrow("player wedged");
    const after = await listMuseSpeakTmpDirs();
    const leaked = after.filter((d) => !before.includes(d));
    expect(leaked).toEqual([]);
  });
});
