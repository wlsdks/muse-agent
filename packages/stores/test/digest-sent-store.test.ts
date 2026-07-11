import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestAlreadySentToday, localDateKey, markDigestSent, readDigestSentDate } from "../src/digest-sent-store.js";

describe("localDateKey", () => {
  it("formats YYYY-MM-DD from local time components", () => {
    expect(localDateKey(new Date(2026, 6, 11, 18, 30, 0))).toBe("2026-07-11");
  });

  it("zero-pads single-digit month/day", () => {
    expect(localDateKey(new Date(2026, 0, 5, 0, 0, 0))).toBe("2026-01-05");
  });
});

describe("digest-sent-store — tolerant reads + atomic write", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-digest-sent-${randomUUID()}-`)); file = join(dir, "digest-sent.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("missing file -> undefined (never sent)", async () => {
    expect(await readDigestSentDate(file)).toBeUndefined();
  });

  it("malformed JSON -> undefined (does not throw)", async () => {
    await writeFile(file, "not json at all", "utf8");
    expect(await readDigestSentDate(file)).toBeUndefined();
  });

  it("wrong shape -> undefined", async () => {
    await writeFile(file, JSON.stringify({ somethingElse: true }), "utf8");
    expect(await readDigestSentDate(file)).toBeUndefined();
  });

  it("markDigestSent then readDigestSentDate round-trips the local date", async () => {
    await markDigestSent(file, new Date(2026, 6, 11, 18, 5, 0));
    expect(await readDigestSentDate(file)).toBe("2026-07-11");
  });

  it("digestAlreadySentToday is true on the same local date, false on a different one", async () => {
    await markDigestSent(file, new Date(2026, 6, 11, 18, 5, 0));
    expect(await digestAlreadySentToday(file, new Date(2026, 6, 11, 23, 0, 0))).toBe(true);
    expect(await digestAlreadySentToday(file, new Date(2026, 6, 12, 18, 5, 0))).toBe(false);
  });

  it("digestAlreadySentToday is false when the sidecar is missing", async () => {
    expect(await digestAlreadySentToday(file, new Date())).toBe(false);
  });
});
