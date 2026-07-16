import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LinuxLibnotifyProvider,
  MessagingProviderError,
  buildNotifySendArgv,
  type NotifySendRunner
} from "../src/index.js";
import { defaultRunner } from "../src/linux-libnotify-provider.js";

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  stdin: { on: () => void; write: () => void; end: () => void };
  kill: (signal?: string) => boolean;
  killedWith?: string;
}

function fakeSpawn(): { spawnFn: typeof spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  // The shared runCommandWithTimeout spawns with full pipes and wires
  // stdout/stdin too — the fake must carry all three streams.
  child.stdout = new EventEmitter();
  child.stdin = { end: () => undefined, on: () => undefined, write: () => undefined };
  child.kill = (signal?: string): boolean => {
    child.killedWith = signal ?? "SIGTERM";
    return true;
  };
  return { child, spawnFn: (() => child) as unknown as typeof spawn };
}

describe("notify-send defaultRunner watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the exit code on a clean close", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner(["Muse", "hi"], spawnFn);
    child.emit("close", 0);
    await expect(p).resolves.toEqual({ exitCode: 0, stderr: "", truncated: false });
  });

  it("SIGKILLs and rejects when notify-send wedges past the timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner(["Muse", "hi"], spawnFn);
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/u);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("ignores a late close after the timeout (single-settle)", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner(["Muse", "hi"], spawnFn);
    const assertion = expect(p).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(30_000);
    child.emit("close", 0);
    await assertion;
  });

  it("decodes a multi-byte UTF-8 character correctly when the notify-send stderr is split across two `data` events (DS-17)", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner(["Muse", "hi"], spawnFn);
    const full = Buffer.from("오류: 디스플레이 없음 🚫", "utf8");
    const splitAt = 4; // mid-character inside a 3-byte Hangul sequence
    child.stderr.emit("data", full.subarray(0, splitAt));
    child.stderr.emit("data", full.subarray(splitAt));
    child.emit("close", 1);
    const result = await p;
    expect(result.stderr).toBe("오류: 디스플레이 없음 🚫");
    expect(result.stderr).not.toContain("�");
  });

  it("bounds an untrusted notify-send diagnostic stream", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner(["Muse", "hi"], spawnFn);
    child.stderr.emit("data", Buffer.alloc(20 * 1024, "x"));
    child.emit("close", 1);
    await expect(p).resolves.toMatchObject({ exitCode: 1, truncated: true });
  });
});

function fakeRunner(): { runner: NotifySendRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "" };
    }
  };
}

describe("LinuxLibnotifyProvider", () => {
  it("buildNotifySendArgv folds title + subtitle into the summary slot", () => {
    expect(buildNotifySendArgv({
      appName: "libnotify",
      urgency: "normal",
      title: "Muse",
      subtitle: "@stark",
      body: "meeting in 5"
    })).toEqual([
      "--app-name", "libnotify",
      "--urgency", "normal",
      "Muse — @stark",
      "meeting in 5"
    ]);

    // Empty subtitle keeps just the title.
    expect(buildNotifySendArgv({
      appName: "libnotify", urgency: "critical", title: "Muse", subtitle: "", body: "x"
    })).toContain("Muse");
    expect(buildNotifySendArgv({
      appName: "libnotify", urgency: "critical", title: "Muse", subtitle: "", body: "x"
    })).not.toContain("Muse — ");
  });

  it("fires notify-send with the expected argv shape via injected runner", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new LinuxLibnotifyProvider({ runner });
    const receipt = await provider.send({ destination: "@stark", text: "deploy done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "--app-name", "libnotify",
      "--urgency", "normal",
      "Muse — @stark",
      "deploy done"
    ]);
    expect(receipt.providerId).toBe("libnotify");
    expect(receipt.messageId).toMatch(/^libnotify-\d+$/);
  });

  it("respects custom title + urgency", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new LinuxLibnotifyProvider({
      runner,
      title: "JARVIS",
      urgency: "critical"
    });
    await provider.send({ destination: "@stark", text: "incident" });
    expect(calls[0]).toEqual([
      "--app-name", "libnotify",
      "--urgency", "critical",
      "JARVIS — @stark",
      "incident"
    ]);
  });

  it("throws UPSTREAM_FAILED on non-linux without an injected runner", () => {
    // We mock through process.platform indirectly by relying on the
    // fact that the runner injection bypasses the guard. So testing
    // the negative case: NO runner injected → constructor's
    // platform() check runs against the real OS. On macOS / CI this
    // host hits the guard.
    if (process.platform !== "linux") {
      expect(() => new LinuxLibnotifyProvider({})).toThrow(MessagingProviderError);
    } else {
      // On Linux the no-runner path is actually fine; provider will
      // try to spawn notify-send, which is acceptable.
      expect(() => new LinuxLibnotifyProvider({})).not.toThrow();
    }
  });

  it("surfaces a non-zero exit as a clear MessagingProviderError", async () => {
    const failing: NotifySendRunner = async () => ({ exitCode: 1, stderr: "no display" });
    const provider = new LinuxLibnotifyProvider({ runner: failing });
    await expect(provider.send({ destination: "@stark", text: "x" })).rejects.toThrow(MessagingProviderError);
  });

  it("marks a truncated notify-send error diagnostic", async () => {
    const failing: NotifySendRunner = async () => ({ exitCode: 1, stderr: "partial failure", truncated: true });
    const provider = new LinuxLibnotifyProvider({ runner: failing });
    await expect(provider.send({ destination: "@stark", text: "x" })).rejects.toThrow(/output truncated/u);
  });
});
