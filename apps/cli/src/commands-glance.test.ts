import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseOsascriptGlance, runOsascript } from "./commands-glance.js";

describe("parseOsascriptGlance", () => {
  it("splits app / window / selected from three lines", () => {
    expect(parseOsascriptGlance("Safari\nMuse — main\nselected snippet")).toEqual({
      app: "Safari",
      selected: "selected snippet",
      window: "Muse — main"
    });
  });

  it("normalises AppleScript 'missing value' and blanks to empty", () => {
    expect(parseOsascriptGlance("Terminal\nmissing value\nmissing value")).toEqual({
      app: "Terminal",
      selected: "",
      window: ""
    });
    expect(parseOsascriptGlance("Finder")).toEqual({ app: "Finder", selected: "", window: "" });
  });

  it("handles CRLF and collapses internal whitespace", () => {
    expect(parseOsascriptGlance("Code\r\n  a\t  b  \r\nx")).toEqual({
      app: "Code",
      selected: "x",
      window: "a b"
    });
  });

  it("strips untrusted terminal control sequences from window/selected", () => {
    const esc = String.fromCharCode(27);
    const out = parseOsascriptGlance(`App\n${esc}[31mred${esc}[0m title\n${esc}]0;evil`);
    expect(out.app).toBe("App");
    expect(out.window.includes(esc)).toBe(false);
    expect(out.window).toContain("red");
    expect(out.selected.includes(esc)).toBe(false);
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
  killedWith?: string;
}

function makeFakeSpawn(): { spawnFn: typeof spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal?: string): boolean => {
    child.killedWith = signal ?? "SIGTERM";
    return true;
  };
  const spawnFn = (() => child) as unknown as typeof spawn;
  return { child, spawnFn };
}

describe("runOsascript", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves stdout on a clean exit", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    child.stdout.emit("data", Buffer.from("Safari\nWin\nSel", "utf8"));
    child.emit("close", 0);
    await expect(promise).resolves.toBe("Safari\nWin\nSel");
  });

  it("rejects with the exit code + stderr on a non-zero exit", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    child.stderr.emit("data", Buffer.from("not allowed", "utf8"));
    child.emit("close", 2);
    await expect(promise).rejects.toThrow(/osascript exited 2: not allowed/u);
  });

  it("rejects on a spawn error", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    child.emit("error", new Error("ENOENT osascript"));
    await expect(promise).rejects.toThrow(/ENOENT osascript/u);
  });

  it("SIGKILLs and rejects when osascript wedges past the timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    const assertion = expect(promise).rejects.toThrow(/timed out after 30000ms/u);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("does not double-settle: a close after the timeout is ignored", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    const assertion = expect(promise).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(30_000);
    // A late close from the killed child must not flip the result.
    child.stdout.emit("data", Buffer.from("late", "utf8"));
    child.emit("close", 0);
    await assertion;
  });
});
