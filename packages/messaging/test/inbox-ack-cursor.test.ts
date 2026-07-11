import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendAckCursor, readAckCursor } from "../src/inbox-ack-cursor.js";

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-ack-cursor-")), "cursor.json");
}

describe("readAckCursor — tolerant loader", () => {
  it("returns an empty set when the file is missing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-ack-cursor-")), "missing.json");
    const set = await readAckCursor(file);
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it("returns an empty set on malformed JSON (fail-open: worst case one duplicate ack)", async () => {
    const file = freshFile();
    writeFileSync(file, "not json");
    expect((await readAckCursor(file)).size).toBe(0);
  });

  it("returns an empty set when version mismatches (1 is the only supported shape)", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ acked: ["tg:1"], version: 2 }));
    expect((await readAckCursor(file)).size).toBe(0);
  });

  it("returns the acked keys for a valid shape (non-string entries silently filtered)", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ acked: ["tg:1", 42, null, "tg:2"], version: 1 }));
    const set = await readAckCursor(file);
    expect([...set].sort()).toEqual(["tg:1", "tg:2"]);
  });
});

describe("appendAckCursor — persist + bound", () => {
  it("is a no-op when newKeys is empty (no file written, no existing payload touched)", async () => {
    const file = freshFile();
    await appendAckCursor(file, []);
    await expect(fsp.access(file)).rejects.toBeTruthy();
  });

  it("appends keys + merges with the existing acked set across calls", async () => {
    const file = freshFile();
    await appendAckCursor(file, ["tg:1", "tg:2"]);
    await appendAckCursor(file, ["tg:2", "tg:3"]);
    const set = await readAckCursor(file);
    expect([...set].sort()).toEqual(["tg:1", "tg:2", "tg:3"]);
  });

  it("bounds the acked set at MAX_ACKED (500) — the OLDEST keys are dropped first", async () => {
    const file = freshFile();
    const batch = Array.from({ length: 600 }, (_, i) => `tg:${i.toString()}`);
    await appendAckCursor(file, batch);
    const set = await readAckCursor(file);
    expect(set.size).toBe(500);
    expect(set.has("tg:0")).toBe(false);
    expect(set.has("tg:99")).toBe(false);
    expect(set.has("tg:100")).toBe(true);
    expect(set.has("tg:599")).toBe(true);
  });

  it("writes the persisted file with mode 0o600 so the keys don't leak via world-readable disk perms", async () => {
    const file = freshFile();
    await appendAckCursor(file, ["tg:1"]);
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});

describe("appendAckCursor — concurrent ticks never lose an acked key", () => {
  it("preserves EVERY key when overlapping ticks each mark a distinct message acked", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => appendAckCursor(file, [`telegram:m${i.toString()}`])));
    const set = await readAckCursor(file);
    expect(set.size).toBe(25);
    expect(set.has("telegram:m12")).toBe(true);
  });

  it("does not crash when concurrent writers race the tmp file (randomUUID tmp, no shared path)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 30 }, () => appendAckCursor(file, ["telegram:dup"])));
    const set = await readAckCursor(file);
    expect(set.size).toBe(1);
    expect(set.has("telegram:dup")).toBe(true);
  });
});
