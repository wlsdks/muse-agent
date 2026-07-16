import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MacosNotificationProvider,
  MessagingProviderError,
  MessagingValidationError,
  type OsascriptRunner
} from "../src/index.js";
import { defaultRunner } from "../src/macos-notification-provider.js";

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

describe("macOS notification defaultRunner watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the exit code on a clean close", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner("display notification \"hi\"", spawnFn);
    child.emit("close", 0);
    await expect(p).resolves.toEqual({ exitCode: 0, stderr: "", truncated: false });
  });

  it("SIGKILLs and rejects when osascript wedges past the timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner("display notification \"hi\"", spawnFn);
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/u);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("ignores a late close after the timeout (single-settle)", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner("x", spawnFn);
    const assertion = expect(p).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(30_000);
    child.emit("close", 0);
    await assertion;
  });

  it("decodes a multi-byte UTF-8 character correctly when the osascript stderr is split across two `data` events (DS-17)", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner("display notification \"hi\"", spawnFn);
    const full = Buffer.from("오류: 권한 없음 🚫", "utf8");
    const splitAt = 4; // mid-character inside a 3-byte Hangul sequence
    child.stderr.emit("data", full.subarray(0, splitAt));
    child.stderr.emit("data", full.subarray(splitAt));
    child.emit("close", 1);
    const result = await p;
    expect(result.stderr).toBe("오류: 권한 없음 🚫");
    expect(result.stderr).not.toContain("�");
  });

  it("bounds an untrusted osascript diagnostic stream", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = defaultRunner("display notification \"hi\"", spawnFn);
    child.stderr.emit("data", Buffer.alloc(20 * 1024, "x"));
    child.emit("close", 1);
    await expect(p).resolves.toMatchObject({ exitCode: 1, truncated: true });
  });
});

function fakeRunner(): { runner: OsascriptRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: async (script: string) => {
      calls.push(script);
      return { exitCode: 0, stderr: "" };
    }
  };
}

describe("MacosNotificationProvider", () => {
  it("fires an osascript with title=Muse, subtitle=destination, body=text", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    const receipt = await provider.send({ destination: "@stark", text: "meeting in 5" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('display notification "meeting in 5"');
    expect(calls[0]).toContain('with title "Muse"');
    expect(calls[0]).toContain('subtitle "@stark"');
    expect(receipt.providerId).toBe("macos-notification");
    expect(receipt.destination).toBe("@stark");
    expect(receipt.messageId).toMatch(/^macos-notification-\d+$/);
  });

  it("escapes double quotes and backslashes so the AppleScript stays valid", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    await provider.send({ destination: "@stark", text: 'has "quotes" and a \\ backslash' });
    expect(calls[0]).toContain('"has \\"quotes\\" and a \\\\ backslash"');
  });

  it("flattens newlines to a single space (Notification Center collapses them anyway)", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    await provider.send({ destination: "@stark", text: "line one\nline two" });
    expect(calls[0]).toContain('"line one line two"');
  });

  it("supports a custom title", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner, title: "Jarvis" });
    await provider.send({ destination: "@stark", text: "hi" });
    expect(calls[0]).toContain('with title "Jarvis"');
  });

  it("throws MessagingProviderError when osascript exits non-zero", async () => {
    const runner: OsascriptRunner = async () => ({ exitCode: 1, stderr: "syntax error" });
    const provider = new MacosNotificationProvider({ runner });
    await expect(provider.send({ destination: "@stark", text: "hi" })).rejects.toBeInstanceOf(MessagingProviderError);
  });

  it("marks a truncated osascript error diagnostic", async () => {
    const runner: OsascriptRunner = async () => ({ exitCode: 1, stderr: "partial failure", truncated: true });
    const provider = new MacosNotificationProvider({ runner });
    await expect(provider.send({ destination: "@stark", text: "hi" })).rejects.toThrow(/output truncated/u);
  });

  it("preserves a successful delivery when only unused diagnostics were truncated", async () => {
    const runner: OsascriptRunner = async () => ({ exitCode: 0, stderr: "", truncated: true });
    const provider = new MacosNotificationProvider({ runner });
    await expect(provider.send({ destination: "@stark", text: "hi" })).resolves.toMatchObject({
      destination: "@stark",
      providerId: "macos-notification"
    });
  });

  it("rejects empty text via validateOutboundMessage", async () => {
    const { runner } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    await expect(provider.send({ destination: "@stark", text: "" })).rejects.toBeInstanceOf(MessagingValidationError);
  });

  it("describes itself as local with the macos-notification id", () => {
    const { runner } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    const info = provider.describe();
    expect(info.id).toBe("macos-notification");
    expect(info.local).toBe(true);
    expect(info.displayName).toMatch(/macOS notification/i);
  });
});
