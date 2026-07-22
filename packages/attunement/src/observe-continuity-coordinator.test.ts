import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPersonalThread, readAttunementState } from "./attunement-store.js";
import {
  deletePersonalThreadContinuitySafe,
  startObserveSessionSafe
} from "./observe-continuity-coordinator.js";
import { forgetObserveSession, readObserveState } from "./observe-store.js";

const directories: string[] = [];
const SESSION_ID = "observe_00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "muse-observe-coordinator-"));
  directories.push(directory);
  return {
    attunementFile: join(directory, "attunement.json"),
    observeFile: join(directory, "attunement.json.observe.json"),
    worksFile: join(directory, "works.json")
  };
}

describe("Observe and PersonalThread lifecycle coordinator", () => {
  it("starts only against an exact thread and preserves both files on missing thread", async () => {
    const target = await files();
    const thread = await createPersonalThread(target.attunementFile, { kind: "work", title: "Exact work" });
    await expect(startObserveSessionSafe(target, { acceptVersion: 1, threadId: thread.id }, {
      idFactory: () => SESSION_ID,
      now: () => new Date("2026-07-22T00:00:00.000Z")
    })).resolves.toMatchObject({ threadId: thread.id });
    const beforeAttunement = await readFile(target.attunementFile, "utf8");
    const beforeObserve = await readFile(target.observeFile, "utf8");
    await expect(startObserveSessionSafe(target, { acceptVersion: 1, threadId: "missing" })).rejects.toMatchObject({ code: "not-found" });
    expect(await readFile(target.attunementFile, "utf8")).toBe(beforeAttunement);
    expect(await readFile(target.observeFile, "utf8")).toBe(beforeObserve);
  });

  it("blocks thread deletion until explicit Observe forget", async () => {
    const target = await files();
    const thread = await createPersonalThread(target.attunementFile, { kind: "work", title: "Exact work" });
    await startObserveSessionSafe(target, { acceptVersion: 1, threadId: thread.id }, {
      idFactory: () => SESSION_ID,
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });
    await expect(deletePersonalThreadContinuitySafe(target, thread.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await readAttunementState(target.attunementFile)).threads).toHaveLength(1);
    await forgetObserveSession(target.observeFile, SESSION_ID);
    await expect(deletePersonalThreadContinuitySafe(target, thread.id)).resolves.toMatchObject({ thread: { id: thread.id } });
    expect((await readObserveState(target.observeFile)).sessions).toEqual([]);
    expect((await readAttunementState(target.attunementFile)).threads).toEqual([]);
  });
});
