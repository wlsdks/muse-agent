import { mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWork, readWorks } from "@muse/stores";

import { createPersonalThread, inspectThread, readAttunementState } from "./attunement-store.js";
import {
  deletePersonalThreadWorkSafe,
  deleteWorkContinuitySafe,
  linkWorkContinuity,
  setWorkContinuityThread,
  unlinkWorkContinuity
} from "./work-continuity-coordinator.js";

const WORK_ID = "work_123e4567-e89b-4d3a-a456-426614174000";
let root: string;
let files: { attunementFile: string; worksFile: string };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-work-continuity-"));
  // Semantic argument order is intentionally opposite lexical lock order.
  files = { attunementFile: join(root, "z-attunement.json"), worksFile: join(root, "a-works.json") };
});
afterEach(async () => rm(root, { force: true, recursive: true }));

async function seed() {
  const work = await createWork(files.worksFile, { goal: "Goal", name: "Name" }, process.env, { idFactory: () => WORK_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
  const first = await createPersonalThread(files.attunementFile, { kind: "work", title: "First" }, { idFactory: () => "one", now: () => new Date("2026-07-22T00:00:00.000Z") });
  const second = await createPersonalThread(files.attunementFile, { kind: "work", title: "Second" }, { idFactory: () => "two", now: () => new Date("2026-07-22T00:00:00.000Z") });
  return { first, second, work };
}

describe("Work Continuity two-store coordinator", () => {
  it("links idempotently and refuses a second PersonalThread", async () => {
    const { first, second } = await seed();
    await expect(linkWorkContinuity(files, { threadId: first.id, workId: WORK_ID })).resolves.toMatchObject({ created: true });
    await expect(linkWorkContinuity(files, { threadId: first.id, workId: WORK_ID })).resolves.toMatchObject({ created: false });
    await expect(linkWorkContinuity(files, { threadId: second.id, workId: WORK_ID })).rejects.toThrow(/another PersonalThread/u);
  });

  it("serializes concurrent cross-thread links so exactly one wins", async () => {
    const { first, second } = await seed();
    const results = await Promise.allSettled([
      linkWorkContinuity(files, { threadId: first.id, workId: WORK_ID }),
      linkWorkContinuity(files, { threadId: second.id, workId: WORK_ID })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await readAttunementState(files.attunementFile)).threads.flatMap((thread) => thread.links)).toHaveLength(1);
  });

  it("keeps the pair valid across concurrent link, assignment, and both deletion directions", async () => {
    const { first, second } = await seed();
    const results = await Promise.allSettled([
      linkWorkContinuity(files, { threadId: first.id, workId: WORK_ID }),
      setWorkContinuityThread(files, { threadId: second.id, workId: WORK_ID }),
      deleteWorkContinuitySafe(files, WORK_ID),
      deletePersonalThreadWorkSafe(files, first.id)
    ]);
    const allowedRejections = [
      /no continuity thread|no local Work|another PersonalThread|already linked/u,
      /no continuity thread|no work|conflicting PersonalThread/u,
      /linked to Personal Continuity/u,
      /assigned to Work/u
    ];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(Error);
        expect((result.reason as Error).message).toMatch(allowedRejections[index]!);
      }
    });
    const state = await readAttunementState(files.attunementFile);
    const works = await readWorks(files.worksFile);
    const links = state.threads.flatMap((thread) => thread.links.filter((link) => link.artifactType === "work"));
    expect(new Set(links.map((link) => link.artifactId)).size).toBe(links.length);
    for (const link of links) expect(works.some((work) => work.id === link.artifactId)).toBe(true);
    for (const work of works) {
      if (work.threadId) expect(state.threads.some((thread) => thread.id === work.threadId)).toBe(true);
    }
  });

  it("guards assignment and both deletion directions until explicit unlink/clear", async () => {
    const { first, second } = await seed();
    await linkWorkContinuity(files, { threadId: first.id, workId: WORK_ID });
    let beforeWork = await readFile(files.worksFile);
    let beforeAttunement = await readFile(files.attunementFile);
    await expect(setWorkContinuityThread(files, { threadId: second.id, workId: WORK_ID })).rejects.toThrow(/conflicting/u);
    expect(await readFile(files.worksFile)).toEqual(beforeWork);
    expect(await readFile(files.attunementFile)).toEqual(beforeAttunement);
    beforeWork = await readFile(files.worksFile);
    beforeAttunement = await readFile(files.attunementFile);
    await expect(deleteWorkContinuitySafe(files, WORK_ID)).rejects.toThrow(/unlink it first/u);
    expect(await readFile(files.worksFile)).toEqual(beforeWork);
    expect(await readFile(files.attunementFile)).toEqual(beforeAttunement);
    await unlinkWorkContinuity(files, { threadId: first.id, workId: WORK_ID });
    await setWorkContinuityThread(files, { threadId: first.id, workId: WORK_ID });
    beforeWork = await readFile(files.worksFile);
    beforeAttunement = await readFile(files.attunementFile);
    await expect(deletePersonalThreadWorkSafe(files, first.id)).rejects.toThrow(/clear it first/u);
    expect(await readFile(files.worksFile)).toEqual(beforeWork);
    expect(await readFile(files.attunementFile)).toEqual(beforeAttunement);
    await setWorkContinuityThread(files, { workId: WORK_ID });
    await expect(deletePersonalThreadWorkSafe(files, first.id)).resolves.toMatchObject({ thread: { id: first.id } });
    expect(inspectThread(await readAttunementState(files.attunementFile), second.id)).toMatchObject({ thread: { id: second.id } });
    await expect(deleteWorkContinuitySafe(files, WORK_ID)).resolves.toBe(true);
    expect(await readWorks(files.worksFile)).toEqual([]);
  });

  it("rejects a same-path configuration before taking locks", async () => {
    await expect(linkWorkContinuity({ attunementFile: files.worksFile, worksFile: files.worksFile }, { threadId: "x", workId: WORK_ID }))
      .rejects.toThrow(/different files/u);
  });

  it("rejects normalized-empty Work text before linking and preserves both stores", async () => {
    await createWork(files.worksFile, { goal: "\u0000\t", name: "\u0000\n" }, process.env, { idFactory: () => WORK_ID });
    const thread = await createPersonalThread(files.attunementFile, { kind: "work", title: "Safe" });
    const beforeWork = await readFile(files.worksFile);
    const beforeAttunement = await readFile(files.attunementFile);
    await expect(linkWorkContinuity(files, { threadId: thread.id, workId: WORK_ID })).rejects.toThrow(/non-empty safe/u);
    expect(await readFile(files.worksFile)).toEqual(beforeWork);
    expect(await readFile(files.attunementFile)).toEqual(beforeAttunement);
  });

  it("canonicalizes existing symlink aliases and rejects a same-file collision", async () => {
    await createWork(files.worksFile, { goal: "Goal", name: "Name" }, process.env, { idFactory: () => WORK_ID });
    const alias = join(root, "works-alias.json");
    await symlink(files.worksFile, alias);
    await expect(linkWorkContinuity({ attunementFile: alias, worksFile: files.worksFile }, { threadId: "x", workId: WORK_ID }))
      .rejects.toThrow(/different files/u);
  });

  it("rejects a dangling store symlink without changing the other store or alias", async () => {
    await createWork(files.worksFile, { goal: "Goal", name: "Name" }, process.env, { idFactory: () => WORK_ID });
    const dangling = join(root, "dangling-attunement.json");
    const missingTarget = join(root, "missing-attunement.json");
    await symlink(missingTarget, dangling);
    const beforeWork = await readFile(files.worksFile);
    const beforeAlias = await readlink(dangling);
    await expect(linkWorkContinuity(
      { attunementFile: dangling, worksFile: files.worksFile },
      { threadId: "thread_missing", workId: WORK_ID }
    )).rejects.toThrow(/dangling symlink/u);
    expect(await readFile(files.worksFile)).toEqual(beforeWork);
    expect(await readlink(dangling)).toBe(beforeAlias);
  });
});
