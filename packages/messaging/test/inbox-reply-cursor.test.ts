import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendReplyCursor, readReplyCursor } from "../src/inbox-reply-cursor.js";

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-reply-cursor-")), "cursor.json");
}

describe("readReplyCursor — tolerant loader", () => {
  it("returns an empty set when the file is missing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-reply-cursor-")), "missing.json");
    const set = await readReplyCursor(file);
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it("returns an empty set on malformed JSON (the loop re-answers; safer than crashing)", async () => {
    const file = freshFile();
    writeFileSync(file, "not json");
    expect((await readReplyCursor(file)).size).toBe(0);
  });

  it("returns an empty set when version mismatches (1 is the only supported shape)", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ handled: ["tg:1"], version: 2 }));
    expect((await readReplyCursor(file)).size).toBe(0);
  });

  it("returns the handled keys for a valid shape (non-string entries silently filtered)", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ handled: ["tg:1", 42, null, "tg:2"], version: 1 }));
    const set = await readReplyCursor(file);
    expect([...set].sort()).toEqual(["tg:1", "tg:2"]);
  });
});

describe("appendReplyCursor — persist + bound", () => {
  it("is a no-op when newKeys is empty (no file written, no existing payload touched)", async () => {
    const file = freshFile();
    await appendReplyCursor(file, []);
    await expect(fsp.access(file)).rejects.toBeTruthy();
  });

  it("appends keys + merges with the existing handled set across calls", async () => {
    const file = freshFile();
    await appendReplyCursor(file, ["tg:1", "tg:2"]);
    await appendReplyCursor(file, ["tg:2", "tg:3"]);
    const set = await readReplyCursor(file);
    expect([...set].sort()).toEqual(["tg:1", "tg:2", "tg:3"]);
  });

  it("bounds the handled set at MAX_HANDLED (500) — the OLDEST keys are dropped first", async () => {
    const file = freshFile();
    const batch = Array.from({ length: 600 }, (_, i) => `tg:${i.toString()}`);
    await appendReplyCursor(file, batch);
    const set = await readReplyCursor(file);
    expect(set.size).toBe(500);
    // Oldest 100 (tg:0 .. tg:99) dropped, latest 500 retained.
    expect(set.has("tg:0")).toBe(false);
    expect(set.has("tg:99")).toBe(false);
    expect(set.has("tg:100")).toBe(true);
    expect(set.has("tg:599")).toBe(true);
  });

  it("writes the persisted file with mode 0o600 so the keys don't leak via world-readable disk perms", async () => {
    const file = freshFile();
    await appendReplyCursor(file, ["tg:1"]);
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});

// Concurrency — this cursor's whole job is "an overlapping tick never
// double-replies". A lost key under a race means a message gets answered
// TWICE. Before the per-file queue + randomUUID tmp, the read-merge-write
// clobbered and the `${file}.tmp-${pid}` (no uniquifier) collided in-process.
describe("appendReplyCursor — concurrent ticks never lose an answered key", () => {
  it("preserves EVERY key when overlapping ticks each mark a distinct message answered", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => appendReplyCursor(file, [`telegram:m${i.toString()}`])));
    const set = await readReplyCursor(file);
    expect(set.size).toBe(25); // not last-writer-wins (would drop most) → no double-reply
    expect(set.has("telegram:m12")).toBe(true);
  });

  it("does not crash when concurrent writers race the tmp file (randomUUID tmp, no shared path)", async () => {
    const file = freshFile();
    // same key from many ticks at once — the old shared `${file}.tmp-${pid}`
    // path made two in-flight renames collide; the uuid tmp makes each unique.
    await Promise.all(Array.from({ length: 30 }, () => appendReplyCursor(file, ["telegram:dup"])));
    const set = await readReplyCursor(file);
    expect(set.size).toBe(1);
    expect(set.has("telegram:dup")).toBe(true);
  });
});
