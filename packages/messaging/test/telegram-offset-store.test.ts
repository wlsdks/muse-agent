import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTelegramOffset, writeTelegramOffset } from "../src/telegram-offset-store.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) {
    await rm(directory, { force: true, recursive: true });
    directory = undefined;
  }
});

describe("Telegram offset store", () => {
  it("keeps the highest offset when overlapping polls finish out of order", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-telegram-offset-"));
    const file = join(directory, "offset.json");

    await Promise.all([writeTelegramOffset(file, 27), writeTelegramOffset(file, 11)]);

    expect(await readTelegramOffset(file)).toBe(27);
  });
});
