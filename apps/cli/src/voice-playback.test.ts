import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_FORMATS,
  AUDIO_PLAYER_TIMEOUT_MS,
  parseAudioFormat,
  playAudioWithWatchdog
} from "./voice-playback.js";

interface FakeChild extends EventEmitter {
  kill: (signal?: string) => boolean;
  killedWith?: string;
}

function makeFakeSpawn(): { spawnFn: typeof spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.kill = (signal?: string): boolean => {
    child.killedWith = signal ?? "SIGTERM";
    return true;
  };
  const spawnFn = (() => child) as unknown as typeof spawn;
  return { child, spawnFn };
}

describe("parseAudioFormat (goal 169)", () => {
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
