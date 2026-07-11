import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTelegramOffset, writeTelegramOffset } from "../src/telegram-offset-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-tg-offset-"));
  file = join(dir, "nested", "offset.json"); // nested → exercises mkdir recursive
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("telegram-offset-store", () => {
  it("returns undefined for a not-yet-created file (first poll starts at Telegram's default)", async () => {
    expect(await readTelegramOffset(file)).toBeUndefined();
  });

  it("round-trips an offset and overwrites on the next write (single value, not merge)", async () => {
    await writeTelegramOffset(file, 100);
    expect(await readTelegramOffset(file)).toBe(100);
    await writeTelegramOffset(file, 205);
    expect(await readTelegramOffset(file)).toBe(205);
  });

  it("truncates a fractional offset on WRITE (Telegram update_ids are integers)", async () => {
    await writeTelegramOffset(file, 100.9);
    expect(await readTelegramOffset(file)).toBe(100);
    // and the persisted JSON itself holds the truncated integer
    expect(JSON.parse(await readFile(file, "utf8")).offset).toBe(100);
  });

  it("truncates a fractional offset on READ too (a hand-edited float is normalised)", async () => {
    const flat = join(dir, "float.json");
    await writeFile(flat, JSON.stringify({ offset: 42.7, version: 1 }), "utf8");
    expect(await readTelegramOffset(flat)).toBe(42);
  });

  it("rejects a non-finite offset (NaN / Infinity) with a TypeError — a bad write would break polling", async () => {
    await expect(writeTelegramOffset(file, Number.NaN)).rejects.toBeInstanceOf(TypeError);
    await expect(writeTelegramOffset(file, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(TypeError);
  });

  it("writes the offset sidecar with 0600 permissions (it reveals the bot's polling cadence + chat ids)", async () => {
    await writeTelegramOffset(file, 1);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file, a missing offset, or a non-number/non-finite offset as 'no offset'", async () => {
    const flat = join(dir, "bad.json");
    await writeFile(flat, "{ not json", "utf8");
    expect(await readTelegramOffset(flat)).toBeUndefined();

    await writeFile(flat, JSON.stringify({ version: 1 }), "utf8"); // no offset
    expect(await readTelegramOffset(flat)).toBeUndefined();

    await writeFile(flat, JSON.stringify({ offset: "100", version: 1 }), "utf8"); // string, not number
    expect(await readTelegramOffset(flat)).toBeUndefined();

    await writeFile(flat, JSON.stringify({ offset: null, version: 1 }), "utf8");
    expect(await readTelegramOffset(flat)).toBeUndefined();
  });
});
