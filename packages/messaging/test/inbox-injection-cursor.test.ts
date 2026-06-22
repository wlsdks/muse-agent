import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceInboxInjectionCursor,
  readInboxInjectionCursor,
  writeInboxInjectionCursor
} from "../src/inbox-injection-cursor.js";

let workdir: string;
let cursorFile: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "muse-inbox-cursor-"));
  cursorFile = join(workdir, "slack-cursor.json");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("inbox-injection-cursor", () => {
  it("read returns empty when file is missing", async () => {
    expect(await readInboxInjectionCursor(cursorFile)).toEqual({});
  });

  it("write then read round-trips", async () => {
    await writeInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" } });
    expect(await readInboxInjectionCursor(cursorFile)).toEqual({ C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" } });
  });

  it("persists the cursor file with mode 0o600 (parallel to telegram-offset / slack-after / discord-after / inbox-store — pre-fix this sidecar leaked per-user polling cadence on a shared box)", async () => {
    // The cursor records the LAST timestamp each chat / channel was
    // injected from per user; a world-readable file would reveal
    // when the user is active in which channel — same shape concern
    // goal 598 closed for the sibling sidecars. Both writes go
    // through `writePersisted`, so testing one entry-point is
    // sufficient to pin the chmod posture.
    await writeInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" } });
    expect(statSync(cursorFile).mode & 0o777).toBe(0o600);
    // advance() rewrites the file too — verify the mode survives
    // the rename + the second writePersisted call.
    await advanceInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T09:00:00.000Z" } });
    expect(statSync(cursorFile).mode & 0o777).toBe(0o600);
  });

  it("advance keeps newest ISO per source", async () => {
    await writeInboxInjectionCursor(cursorFile, {
      C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" },
      C2: { ids: [], iso: "2026-05-11T07:00:00.000Z" }
    });
    const merged = await advanceInboxInjectionCursor(cursorFile, {
      C1: { ids: [], iso: "2026-05-11T07:30:00.000Z" }, // older — should not overwrite
      C2: { ids: [], iso: "2026-05-11T09:00:00.000Z" }, // newer — wins
      C3: { ids: [], iso: "2026-05-11T06:00:00.000Z" } // new source
    });
    expect(merged).toEqual({
      C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" },
      C2: { ids: [], iso: "2026-05-11T09:00:00.000Z" },
      C3: { ids: [], iso: "2026-05-11T06:00:00.000Z" }
    });
  });

  it("advances by instant, not raw string (mixed precision / timezone offset / garbage)", async () => {
    await writeInboxInjectionCursor(cursorFile, {
      C1: { ids: [], iso: "2026-05-11T08:00:01Z" }, // whole-second prior, no fraction
      C2: { ids: [], iso: "2026-05-11T10:00:00.000Z" },
      C3: { ids: [], iso: "2026-05-11T05:00:00.000Z" }
    });
    const merged = await advanceInboxInjectionCursor(cursorFile, {
      // Later instant but string-sorts BEFORE "…01Z" ("." < "Z").
      C1: { ids: [], iso: "2026-05-11T08:00:01.500Z" },
      // 18:00+09:00 == 09:00Z — EARLIER than the 10:00Z prior, but
      // string-sorts after it ("18" > "10"). Must not move backward.
      C2: { ids: [], iso: "2026-05-11T18:00:00+09:00" },
      // Unparseable — must never be stored as a cursor value.
      C3: { ids: [], iso: "soon" }
    });
    expect(merged).toEqual({
      C1: { ids: [], iso: "2026-05-11T08:00:01.500Z" }, // advanced (instant is later)
      C2: { ids: [], iso: "2026-05-11T10:00:00.000Z" }, // unchanged (incoming is earlier)
      C3: { ids: [], iso: "2026-05-11T05:00:00.000Z" }  // unchanged (garbage skipped)
    });
  });

  it("isolates per-user cursors so user A's seen state doesn't shadow user B's", async () => {
    await writeInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" } }, "alice");
    await writeInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T09:00:00.000Z" } }, "bob");

    expect(await readInboxInjectionCursor(cursorFile, "alice")).toEqual({
      C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" }
    });
    expect(await readInboxInjectionCursor(cursorFile, "bob")).toEqual({
      C1: { ids: [], iso: "2026-05-11T09:00:00.000Z" }
    });
    // Single-user (no userId) cursor is independent of both.
    expect(await readInboxInjectionCursor(cursorFile)).toEqual({});
  });

  it("migrates a v1 (flat) cursor file into the _global slot transparently", async () => {
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(
      cursorFile,
      JSON.stringify({ lastInjectedAt: { C1: "2026-05-11T07:00:00.000Z" }, version: 1 }, null, 2),
      "utf8"
    );
    // Single-user read sees the migrated v1 entry (a bare ISO string is
    // read as an empty-ids cursor).
    expect(await readInboxInjectionCursor(cursorFile)).toEqual({
      C1: { ids: [], iso: "2026-05-11T07:00:00.000Z" }
    });
    // A new user's read does NOT inherit it.
    expect(await readInboxInjectionCursor(cursorFile, "alice")).toEqual({});
  });

  it("advance for one user preserves other users' cursors", async () => {
    await writeInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" } }, "alice");
    await advanceInboxInjectionCursor(cursorFile, { C1: { ids: [], iso: "2026-05-11T10:00:00.000Z" } }, "bob");

    expect(await readInboxInjectionCursor(cursorFile, "alice")).toEqual({
      C1: { ids: [], iso: "2026-05-11T08:00:00.000Z" }
    });
    expect(await readInboxInjectionCursor(cursorFile, "bob")).toEqual({
      C1: { ids: [], iso: "2026-05-11T10:00:00.000Z" }
    });
  });
});
