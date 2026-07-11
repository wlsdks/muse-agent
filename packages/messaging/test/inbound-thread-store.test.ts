import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendThreadTurns, readThread, type ThreadTurn } from "../src/inbound-thread-store.js";

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-thread-store-")), "threads.json");
}

const userTurn = (content: string): ThreadTurn => ({ content, role: "user" });
const assistantTurn = (content: string): ThreadTurn => ({ content, role: "assistant" });

describe("readThread — tolerant loader", () => {
  it("returns [] for a missing file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-thread-store-")), "missing.json");
    expect(await readThread(file, "tg:c1")).toEqual([]);
  });

  it("returns [] on malformed JSON (the channel just resets, no crash)", async () => {
    const file = freshFile();
    writeFileSync(file, "not json");
    expect(await readThread(file, "tg:c1")).toEqual([]);
  });

  it("returns [] on a version mismatch (only version 1 is supported)", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ threads: { "tg:c1": [{ content: "hi", role: "user" }] }, version: 2 }));
    expect(await readThread(file, "tg:c1")).toEqual([]);
  });

  it("returns the per-key thread for a valid shape; filters non-turn entries", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({
      threads: {
        "tg:c1": [
          { content: "hi", role: "user" },
          { foo: "bar" },                                            // not a turn
          { content: 42, role: "user" },                             // non-string content
          { content: "hi back", role: "system" },                    // bad role
          { content: "hello sir", role: "assistant" }
        ]
      },
      version: 1
    }));
    const turns = await readThread(file, "tg:c1");
    expect(turns).toEqual([
      { content: "hi", role: "user" },
      { content: "hello sir", role: "assistant" }
    ]);
  });

  it("returns [] for an unknown channel key (does not bleed across channels)", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({
      threads: { "tg:c1": [{ content: "hi", role: "user" }] },
      version: 1
    }));
    expect(await readThread(file, "tg:c2")).toEqual([]);
  });
});

describe("appendThreadTurns — persist + bound + per-channel isolation", () => {
  it("is a no-op when turns is empty (no file written)", async () => {
    const file = freshFile();
    await appendThreadTurns(file, "tg:c1", []);
    await expect(fsp.access(file)).rejects.toBeTruthy();
  });

  it("appends turns and merges with prior content across calls", async () => {
    const file = freshFile();
    await appendThreadTurns(file, "tg:c1", [userTurn("hi"), assistantTurn("hello sir")]);
    await appendThreadTurns(file, "tg:c1", [userTurn("any tasks?")]);
    expect(await readThread(file, "tg:c1")).toEqual([
      { content: "hi", role: "user" },
      { content: "hello sir", role: "assistant" },
      { content: "any tasks?", role: "user" }
    ]);
  });

  it("isolates threads per key — channel A's history never bleeds into channel B", async () => {
    const file = freshFile();
    await appendThreadTurns(file, "tg:c1", [userTurn("hi from A")]);
    await appendThreadTurns(file, "tg:c2", [userTurn("hi from B")]);
    expect(await readThread(file, "tg:c1")).toEqual([{ content: "hi from A", role: "user" }]);
    expect(await readThread(file, "tg:c2")).toEqual([{ content: "hi from B", role: "user" }]);
  });

  it("bounds the per-thread history at MAX_TURNS (12) — the OLDEST turns drop first", async () => {
    const file = freshFile();
    const fifteen: ThreadTurn[] = Array.from({ length: 15 }, (_, i) =>
      i % 2 === 0 ? userTurn(`u${i.toString()}`) : assistantTurn(`a${i.toString()}`));
    await appendThreadTurns(file, "tg:c1", fifteen);
    const turns = await readThread(file, "tg:c1");
    expect(turns.length).toBe(12);
    // Oldest 3 dropped (indices 0-2 = u0, a1, u2), latest 12 kept (3..14).
    expect(turns[0]).toEqual({ content: "a3", role: "assistant" });
    expect(turns[turns.length - 1]).toEqual({ content: "u14", role: "user" });
  });

  it("writes the persisted file with mode 0o600 (the messages contain user content)", async () => {
    const file = freshFile();
    await appendThreadTurns(file, "tg:c1", [userTurn("hi")]);
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("serialises concurrent appendThreadTurns calls per file — two channels arriving at the same instant both land instead of one clobbering the other (pre-fix the unserialised read-modify-write lost the first caller's update when a Telegram inbound and a Discord inbound fired in the same tick)", async () => {
    const file = freshFile();
    await Promise.all([
      appendThreadTurns(file, "tg:c1", [userTurn("hi from A")]),
      appendThreadTurns(file, "discord:c2", [userTurn("hi from B")])
    ]);
    expect(await readThread(file, "tg:c1")).toEqual([{ content: "hi from A", role: "user" }]);
    expect(await readThread(file, "discord:c2")).toEqual([{ content: "hi from B", role: "user" }]);
  });

  it("serialises concurrent appendThreadTurns calls to the SAME key — both updates land in order, neither is lost", async () => {
    const file = freshFile();
    await Promise.all([
      appendThreadTurns(file, "tg:c1", [userTurn("first")]),
      appendThreadTurns(file, "tg:c1", [userTurn("second")])
    ]);
    const turns = await readThread(file, "tg:c1");
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.content).sort()).toEqual(["first", "second"]);
  });
});
