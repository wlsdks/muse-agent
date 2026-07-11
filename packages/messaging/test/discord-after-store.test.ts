import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDiscordAfter, writeDiscordAfter } from "../src/discord-after-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-discord-after-"));
  file = join(dir, "nested", "after.json"); // nested → exercises mkdir recursive
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("discord-after-store", () => {
  it("returns undefined for a channel in a not-yet-created file (first poll falls back to snapshot)", async () => {
    expect(await readDiscordAfter(file, "chan-1")).toBeUndefined();
  });

  it("round-trips a per-channel snowflake verbatim (string, no precision loss)", async () => {
    await writeDiscordAfter(file, "chan-1", "1234567890123456789"); // 19-digit > Number.MAX_SAFE_INTEGER
    expect(await readDiscordAfter(file, "chan-1")).toBe("1234567890123456789");
  });

  it("isolates channels — writing one doesn't leak into another, and a second write merges", async () => {
    await writeDiscordAfter(file, "chan-1", "111");
    await writeDiscordAfter(file, "chan-2", "222");
    expect(await readDiscordAfter(file, "chan-1")).toBe("111"); // not clobbered by chan-2
    expect(await readDiscordAfter(file, "chan-2")).toBe("222");
    expect(await readDiscordAfter(file, "chan-3")).toBeUndefined();
  });

  it("rejects an empty or non-string cursor (a bad write would poison every future poll)", async () => {
    await expect(writeDiscordAfter(file, "chan-1", "")).rejects.toBeInstanceOf(TypeError);
    await expect(writeDiscordAfter(file, "chan-1", undefined as unknown as string)).rejects.toBeInstanceOf(TypeError);
  });

  it("writes the cursor sidecar with 0600 permissions (it names every channel the bot polls)", async () => {
    await writeDiscordAfter(file, "chan-1", "1");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file, a missing 'after' key, or a non-string value as 'no cursor' (graceful)", async () => {
    const flat = join(dir, "bad.json");
    await writeFile(flat, "{ not json", "utf8");
    expect(await readDiscordAfter(flat, "chan-1")).toBeUndefined();

    await writeFile(flat, JSON.stringify({ version: 1 }), "utf8"); // no `after`
    expect(await readDiscordAfter(flat, "chan-1")).toBeUndefined();

    await writeFile(flat, JSON.stringify({ after: { "chan-1": 123, "chan-2": "" }, version: 1 }), "utf8");
    expect(await readDiscordAfter(flat, "chan-1")).toBeUndefined(); // numeric value filtered
    expect(await readDiscordAfter(flat, "chan-2")).toBeUndefined(); // empty string filtered
  });
});
