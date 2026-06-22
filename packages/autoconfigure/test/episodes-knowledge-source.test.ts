import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeEpisodes } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEpisodeKnowledgeEntries } from "../src/episodes-knowledge-source.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-episodes-ks-"));
  file = join(dir, "episodes.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const episode = (id: string, userId: string, endedAt: string, summary: string) => ({
  endedAt,
  id,
  startedAt: endedAt,
  summary,
  userId
});

describe("readEpisodeKnowledgeEntries — episodes as a recall source", () => {
  it("returns only the given user's episodes, newest-first, mapped to {id, summary, when}", async () => {
    await writeEpisodes(file, [
      episode("e1", "alice", "2026-05-18T10:00:00Z", "Older alice session about taxes."),
      episode("e2", "bob", "2026-05-20T10:00:00Z", "Bob session — should be excluded."),
      episode("e3", "alice", "2026-05-22T10:00:00Z", "Newer alice session about the Acme renewal.")
    ]);
    const out = await readEpisodeKnowledgeEntries(file, "alice", 10);
    expect(out).toEqual([
      { id: "e3", summary: "Newer alice session about the Acme renewal.", when: "2026-05-22" },
      { id: "e1", summary: "Older alice session about taxes.", when: "2026-05-18" }
    ]);
  });

  it("honours the limit (most-recent N)", async () => {
    await writeEpisodes(file, [
      episode("e1", "alice", "2026-05-18T10:00:00Z", "one"),
      episode("e2", "alice", "2026-05-20T10:00:00Z", "two"),
      episode("e3", "alice", "2026-05-22T10:00:00Z", "three")
    ]);
    const out = await readEpisodeKnowledgeEntries(file, "alice", 1);
    expect(out.map((e) => e.id)).toEqual(["e3"]);
  });

  it("is fail-open: a missing store yields [] (never throws into recall)", async () => {
    expect(await readEpisodeKnowledgeEntries(join(dir, "nope.json"), "alice", 10)).toEqual([]);
  });
});
