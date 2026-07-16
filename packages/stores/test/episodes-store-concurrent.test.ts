import { randomUUID } from "node:crypto";
import { rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readEpisodes, removeEpisode, upsertEpisode, type PersistedEpisode } from "../src/personal-episodes-store.js";

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-episodes-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => { await Promise.all(files.map((f) => rm(f, { force: true }))); files = []; });

const episode = (id: string): PersistedEpisode => ({
  endedAt: "2026-06-01T01:00:00Z",
  id,
  startedAt: "2026-06-01T00:00:00Z",
  summary: `recap ${id}`,
  userId: "u"
});

// upsertEpisode / removeEpisode are read-modify-write. Before the per-file
// mutation queue, concurrent session-end upserts lost episodes (last write
// clobbered the rest — a lost episode is a session the recall WEDGE can never
// surface) and crashed with ENOENT on the same-ms tmp-${pid}-${Date.now()} path.
describe("episodes store under concurrency", () => {
  it("keeps every concurrently-upserted episode (no lost session, no rename crash)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => upsertEpisode(file, episode(`ep${i.toString()}`))));
    const all = await readEpisodes(file);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((e) => e.id)).size).toBe(25);
  }, 30_000);

  it("applies concurrent removes exactly, leaving the untouched episodes", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => upsertEpisode(file, episode(`ep${i.toString()}`))));
    await Promise.all(Array.from({ length: 10 }, (_unused, i) => removeEpisode(file, `ep${i.toString()}`)));
    expect(await readEpisodes(file)).toHaveLength(15);
  }, 30_000);

  it("preserves an external upsert committed while this process waits for the file lock", async () => {
    const file = freshFile();
    await upsertEpisode(file, episode("local-first"));

    await writeFile(`${file}.lock`, "external writer", { flag: "wx" });
    const localAppend = upsertEpisode(file, episode("local-second"));
    await sleep(300);

    const first = (await readEpisodes(file))[0]!;
    await writeFile(file, `${JSON.stringify({ episodes: [first, episode("external")] }, null, 2)}\n`);
    await unlink(`${file}.lock`);

    await localAppend;
    expect((await readEpisodes(file)).map(({ id }) => id)).toEqual(["local-first", "external", "local-second"]);
  });
});
