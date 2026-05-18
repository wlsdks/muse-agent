import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIEF_AUDIO_PLAYER_TIMEOUT_MS, playAudioFile } from "./commands-brief.js";

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

describe("playAudioFile (muse brief --speak player watchdog)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the player exits 0", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the exit code on a non-zero exit", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("aplay", "/tmp/brief.wav", spawnFn);
    child.emit("close", 3);
    await expect(promise).rejects.toThrow(/aplay exit 3/u);
  });

  it("rejects on a spawn error (player not installed)", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    child.emit("error", new Error("ENOENT afplay"));
    await expect(promise).rejects.toThrow(/ENOENT afplay/u);
  });

  it("SIGKILLs and rejects when the player wedges past the timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    const assertion = expect(promise).rejects.toThrow(/afplay timed out after 30000ms and was killed/u);
    await vi.advanceTimersByTimeAsync(BRIEF_AUDIO_PLAYER_TIMEOUT_MS);
    await assertion;
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("does not double-settle: a late close after the timeout is ignored", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    const assertion = expect(promise).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(BRIEF_AUDIO_PLAYER_TIMEOUT_MS);
    child.emit("close", 0);
    await assertion;
  });
});
