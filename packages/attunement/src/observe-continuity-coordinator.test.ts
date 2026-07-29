import { link, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPersonalThread, readAttunementState } from "./attunement-store.js";
import {
  deletePersonalThreadContinuitySafe,
  resumeObserveSessionSafe,
  startObserveSessionSafe
} from "./observe-continuity-coordinator.js";
import {
  OBSERVE_CONSENT_TEMPLATE,
  OBSERVE_CONSENT_VERSION,
  forgetObserveSession,
  pauseObserveSession,
  readObserveState
} from "./observe-store.js";

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
    await expect(startObserveSessionSafe(target, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: thread.id }, {
      idFactory: () => SESSION_ID,
      now: () => new Date("2026-07-22T00:00:00.000Z")
    })).resolves.toMatchObject({ threadId: thread.id });
    const beforeAttunement = await readFile(target.attunementFile, "utf8");
    const beforeObserve = await readFile(target.observeFile, "utf8");
    await expect(startObserveSessionSafe(target, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "missing" })).rejects.toMatchObject({ code: "not-found" });
    expect(await readFile(target.attunementFile, "utf8")).toBe(beforeAttunement);
    expect(await readFile(target.observeFile, "utf8")).toBe(beforeObserve);
  });

  it("blocks thread deletion until explicit Observe forget", async () => {
    const target = await files();
    const thread = await createPersonalThread(target.attunementFile, { kind: "work", title: "Exact work" });
    await startObserveSessionSafe(target, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: thread.id }, {
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

  it("rejects distinct paths that alias the same store inode", async () => {
    const target = await files();
    const thread = await createPersonalThread(target.attunementFile, { kind: "work", title: "Exact work" });
    await link(target.attunementFile, target.observeFile);
    await expect(startObserveSessionSafe(target, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: thread.id })).rejects.toMatchObject({ code: "invalid" });
  });

  it("serializes start/delete, competing resume, and forget/delete races across pass^5", async () => {
    for (let pass = 0; pass < 5; pass += 1) {
      const startDelete = await files();
      const thread = await createPersonalThread(startDelete.attunementFile, { kind: "work", title: "Race" });
      await Promise.allSettled([
        startObserveSessionSafe(startDelete, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: thread.id }, { idFactory: () => SESSION_ID }),
        deletePersonalThreadContinuitySafe(startDelete, thread.id)
      ]);
      const afterThreads = (await readAttunementState(startDelete.attunementFile)).threads;
      const afterSessions = await readObserveState(startDelete.observeFile);
      expect(afterSessions.sessions.every((session) => afterThreads.some((candidate) => candidate.id === session.threadId))).toBe(true);

      const resumes = await files();
      const resumeThread = await createPersonalThread(resumes.attunementFile, { kind: "work", title: "Resume" });
      const firstId = "observe_00000000-0000-4000-8000-000000000011";
      const secondId = "observe_00000000-0000-4000-8000-000000000012";
      await startObserveSessionSafe(resumes, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: resumeThread.id }, { idFactory: () => firstId });
      await pauseObserveSession(resumes.observeFile, firstId);
      await startObserveSessionSafe(resumes, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: resumeThread.id }, { idFactory: () => secondId });
      await pauseObserveSession(resumes.observeFile, secondId);
      const resumeResults = await Promise.allSettled([
        resumeObserveSessionSafe(resumes, firstId),
        resumeObserveSessionSafe(resumes, secondId)
      ]);
      expect(resumeResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await readObserveState(resumes.observeFile)).sessions.filter((session) => session.status === "active")).toHaveLength(1);

      const forgetDelete = await files();
      const forgetThread = await createPersonalThread(forgetDelete.attunementFile, { kind: "work", title: "Forget" });
      await startObserveSessionSafe(forgetDelete, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: forgetThread.id }, { idFactory: () => SESSION_ID });
      await Promise.allSettled([
        forgetObserveSession(forgetDelete.observeFile, SESSION_ID),
        deletePersonalThreadContinuitySafe(forgetDelete, forgetThread.id)
      ]);
      expect((await readObserveState(forgetDelete.observeFile)).sessions).toEqual([]);
    }
  });
});
