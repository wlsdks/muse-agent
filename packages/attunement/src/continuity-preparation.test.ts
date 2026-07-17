import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttunementStoreError,
  baselinePolicy,
  openPreparedContinuityPack,
  policyForOutcome,
  readAttunementState,
  resetThreadPolicy,
  type ArtifactLink,
  type AttunementState
} from "./index.js";
import { writeAttunementState } from "./attunement-store.js";

const roots: string[] = [];

const taskLink: ArtifactLink = {
  artifactId: "task_prepare",
  artifactType: "task",
  linkedAt: "2026-07-14T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "next-step",
  threadId: "thread_life"
};

const noteLink: ArtifactLink = {
  artifactId: "birthday/context.md",
  artifactType: "note",
  linkedAt: "2026-07-14T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "context",
  threadId: "thread_life"
};

function state(): AttunementState {
  return {
    deliveries: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 1,
    threads: [{
      createdAt: "2026-07-14T00:00:00.000Z",
      id: "thread_life",
      kind: "life",
      links: [taskLink],
      policy: baselinePolicy(),
      title: "Prepare the birthday"
    }],
    undoResetReceipts: []
  };
}

async function seededFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muse-continuity-preparation-"));
  roots.push(root);
  const file = join(root, "attunement.json");
  await writeAttunementState(file, state());
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("openPreparedContinuityPack", () => {
  it("owns one clock read and atomically opens the exact available pack", async () => {
    const file = await seededFile();
    const now = vi.fn(() => Date.parse("2026-07-18T09:00:00.000Z"));

    const opened = await openPreparedContinuityPack(file, "thread_life", async (link) => ({
      ...link,
      taskDueAt: "2026-07-17T09:00:00.000Z",
      taskStatus: "open",
      title: "Choose flowers"
    }), { idFactory: () => "prepared", now });

    expect(now).toHaveBeenCalledTimes(1);
    expect(opened.pack.nextStep?.taskDueState).toBe("overdue");
    expect(opened.delivery).toMatchObject({ id: "delivery_prepared", openedAt: "2026-07-18T09:00:00.000Z" });
    expect((await readAttunementState(file)).deliveries).toHaveLength(1);
  });

  it("fails closed without a delivery when every exact source is unavailable", async () => {
    const file = await seededFile();

    await expect(openPreparedContinuityPack(file, "thread_life", async () => undefined, {
      now: () => Date.parse("2026-07-18T09:00:00.000Z")
    })).rejects.toThrow(new AttunementStoreError("thread 'thread_life' has no currently available linked evidence; no delivery was recorded"));
    expect((await readAttunementState(file)).deliveries).toHaveLength(0);
  });

  it("opens a Pack when at least one exact source remains available", async () => {
    const file = await seededFile();
    const initial = await readAttunementState(file);
    await writeAttunementState(file, {
      ...initial,
      threads: initial.threads.map((thread) => ({ ...thread, links: [noteLink, taskLink] }))
    });

    const opened = await openPreparedContinuityPack(file, "thread_life", async (link) =>
      link.artifactType === "note" ? undefined : { ...link, taskStatus: "open", title: "Choose flowers" }, {
      idFactory: () => "mixed",
      now: () => Date.parse("2026-07-18T09:00:00.000Z")
    });

    expect(opened.pack.evidence.map((entry) => entry.status)).toEqual(["unavailable", "available"]);
    expect((await readAttunementState(file)).deliveries).toHaveLength(1);
  });

  it("fails closed without a delivery when policy changes during exact resolution", async () => {
    const file = await seededFile();
    const initial = await readAttunementState(file);
    await writeAttunementState(file, {
      ...initial,
      deliveries: [{
        evidenceRefs: [taskLink],
        id: "delivery_seed",
        openedAt: "2026-07-17T08:00:00.000Z",
        outcome: { outcome: "ignored", policyVersion: 1, recordedAt: "2026-07-17T08:01:00.000Z" },
        policyVersion: 0,
        threadId: "thread_life"
      }],
      nextPolicyVersion: 2,
      threads: initial.threads.map((thread) => ({ ...thread, policy: policyForOutcome("ignored", 1) }))
    });

    await expect(openPreparedContinuityPack(file, "thread_life", async (link) => {
      await resetThreadPolicy(file, "thread_life", { idFactory: () => "race", now: () => new Date("2026-07-18T08:59:00.000Z") });
      return { ...link, taskStatus: "open", title: "Choose flowers" };
    }, { now: () => Date.parse("2026-07-18T09:00:00.000Z") })).rejects.toThrow("thread policy changed while building this pack");
    expect((await readAttunementState(file)).deliveries).toHaveLength(1);
  });
});
