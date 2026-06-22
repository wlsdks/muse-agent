import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceInboxInjectionCursor,
  readInboxInjectionCursor,
  writeInboxInjectionCursor
} from "./inbox-injection-cursor.js";

describe("inbox-injection-cursor", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-inbox-cursor-"));
    file = join(dir, "cursor.json");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("round-trips a (iso, ids) cursor", async () => {
    await writeInboxInjectionCursor(file, { "chat-1": { ids: ["a", "b"], iso: "2026-01-01T00:00:01Z" } });
    const read = await readInboxInjectionCursor(file);
    expect(read["chat-1"]?.iso).toBe("2026-01-01T00:00:01Z");
    expect([...(read["chat-1"]?.ids ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("reads a legacy bare-ISO-string per-source value as an empty-ids cursor", async () => {
    // A v2 file written before the (iso, ids) change.
    writeFileSync(
      file,
      JSON.stringify({ byUser: { _global: { "chat-1": "2026-01-01T00:00:05Z" } }, version: 2 })
    );
    const read = await readInboxInjectionCursor(file);
    expect(read["chat-1"]?.iso).toBe("2026-01-01T00:00:05Z");
    expect(read["chat-1"]?.ids).toEqual([]);
  });

  it("Bug 2: advancing at the SAME boundary instant unions the surfaced ids", async () => {
    await advanceInboxInjectionCursor(file, { "chat-1": { ids: ["a"], iso: "2026-01-01T00:00:01Z" } });
    await advanceInboxInjectionCursor(file, { "chat-1": { ids: ["b"], iso: "2026-01-01T00:00:01Z" } });
    const read = await readInboxInjectionCursor(file);
    expect(read["chat-1"]?.iso).toBe("2026-01-01T00:00:01Z");
    expect([...(read["chat-1"]?.ids ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("advancing to a strictly later instant replaces the id set", async () => {
    await advanceInboxInjectionCursor(file, { "chat-1": { ids: ["a"], iso: "2026-01-01T00:00:01Z" } });
    await advanceInboxInjectionCursor(file, { "chat-1": { ids: ["c"], iso: "2026-01-01T00:00:02Z" } });
    const read = await readInboxInjectionCursor(file);
    expect(read["chat-1"]?.iso).toBe("2026-01-01T00:00:02Z");
    expect(read["chat-1"]?.ids).toEqual(["c"]);
  });

  it("Bug 3: concurrent advances of distinct sources do not clobber each other (lossless RMW)", async () => {
    // Two concurrent advances of DIFFERENT sources fired in the same tick.
    // The old unserialized read-modify-write (and same-ms tmp name) would
    // let the second write clobber the first; serialized RMW keeps both.
    await Promise.all([
      advanceInboxInjectionCursor(file, { "chat-1": { ids: ["a"], iso: "2026-01-01T00:00:01Z" } }),
      advanceInboxInjectionCursor(file, { "chat-2": { ids: ["b"], iso: "2026-01-01T00:00:02Z" } })
    ]);
    const read = await readInboxInjectionCursor(file);
    expect(read["chat-1"]?.iso).toBe("2026-01-01T00:00:01Z");
    expect(read["chat-2"]?.iso).toBe("2026-01-01T00:00:02Z");
  });

  it("Bug 3: many concurrent advances all land (no lost update, no tmp collision)", async () => {
    const sources = Array.from({ length: 25 }, (_v, i) => `chat-${i.toString()}`);
    await Promise.all(
      sources.map((source, i) =>
        advanceInboxInjectionCursor(file, { [source]: { ids: [`m${i.toString()}`], iso: `2026-01-01T00:00:${(i + 10).toString()}Z` } })
      )
    );
    const read = await readInboxInjectionCursor(file);
    for (const source of sources) {
      expect(read[source]).toBeDefined();
    }
    // File is valid JSON (no torn/half-renamed write left behind).
    expect(() => JSON.parse(readFileSync(file, "utf8")) as unknown).not.toThrow();
  });
});
