import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OSASCRIPT_SOURCE, parseOsascriptGlance, runOsascript } from "./commands-glance.js";

describe("OSASCRIPT_SOURCE — selection capture must not destroy the user's clipboard", () => {
  it("saves the clipboard BEFORE the Cmd+C and restores it AFTER", () => {
    const save = OSASCRIPT_SOURCE.indexOf("set savedClipboard to (the clipboard as text)");
    const copy = OSASCRIPT_SOURCE.indexOf('keystroke "c" using {command down}');
    const restore = OSASCRIPT_SOURCE.indexOf("set the clipboard to savedClipboard");
    expect(save).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    // Snapshot the user's clipboard before the copy, put it back after.
    expect(save).toBeLessThan(copy);
    expect(restore).toBeGreaterThan(copy);
  });
});

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

  it("keeps a multi-line selection whole (everything from line 3 on), not just its first line", () => {
    // A paragraph selection is common — osascript returns it verbatim
    // after app+window, so the selected text spans several lines.
    expect(parseOsascriptGlance("Safari\nDocs\nfirst line\nsecond line\nthird")).toEqual({
      app: "Safari",
      selected: "first line second line third",
      window: "Docs"
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

  it("decodes a multi-byte UTF-8 character correctly when stdout is split across two `data` events (DS-17)", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    // A Korean app name + window title + emoji-bearing selection — exactly
    // the shape of real `muse glance` output that can straddle a chunk
    // boundary mid-character.
    const full = Buffer.from("메모\n회의록 정리\n선택된 텍스트 🎉", "utf8");
    const splitAt = 4; // mid-character inside a 3-byte Hangul sequence
    child.stdout.emit("data", full.subarray(0, splitAt));
    child.stdout.emit("data", full.subarray(splitAt));
    child.emit("close", 0);
    const result = await promise;
    expect(result).toBe("메모\n회의록 정리\n선택된 텍스트 🎉");
    expect(result).not.toContain("�");
  });

  it("rejects with the exit code + stderr on a non-zero exit", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = runOsascript(spawnFn);
    child.stderr.emit("data", Buffer.from("not allowed", "utf8"));
    child.emit("close", 2);
    await expect(promise).rejects.toThrow(/osascript exited with code 2: not allowed/u);
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
