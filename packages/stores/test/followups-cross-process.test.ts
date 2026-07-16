import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFollowups, upsertFollowup, writeFollowups, type PersistedFollowup } from "../src/personal-followups-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-followups-cross-process-"));
  file = join(dir, "followups.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const followup = (id: string): PersistedFollowup => ({
  createdAt: "2026-07-16T00:00:00.000Z",
  id,
  scheduledFor: "2026-07-17T00:00:00.000Z",
  status: "scheduled",
  summary: `follow up ${id}`,
  userId: "u"
});

describe("upsertFollowup", () => {
  it("reads after an external lock releases so it preserves another process's update", async () => {
    await writeFollowups(file, [followup("seed")]);
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    const pending = upsertFollowup(file, followup("local"));
    await sleep(300);
    await writeFile(file, JSON.stringify({ followups: [followup("seed"), followup("external")] }), "utf8");
    await unlink(lockPath);
    await pending;

    expect((await readFollowups(file)).map((entry) => entry.id).sort()).toEqual(["external", "local", "seed"]);
  }, 10_000);
});
