import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CalendarProviderRegistry,
  encodeCalendarEventReference,
  type CalendarEvent,
  type CalendarProvider
} from "@muse/calendar";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttunementStoreError,
  baselinePolicy,
  createCalendarExactArtifactResolver,
  openPreparedContinuityPack,
  policyForOutcome,
  readAttunementState,
  readPreparedContinuityPack,
  resetThreadPolicy,
  type ArtifactLink,
  type AttunementState,
  type ResolvedArtifact
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
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
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
  it("previews only one exact recurring calendar occurrence without recording a delivery", async () => {
    const file = await seededFile();
    const selected: CalendarEvent = {
      allDay: false,
      endsAt: new Date("2026-07-25T10:00:00.000Z"),
      id: "series_team_sync",
      providerId: "gcal",
      startsAt: new Date("2026-07-25T09:00:00.000Z"),
      title: "Selected team sync"
    };
    const sibling: CalendarEvent = {
      ...selected,
      endsAt: new Date("2026-08-01T10:00:00.000Z"),
      startsAt: new Date("2026-08-01T09:00:00.000Z"),
      title: "Sibling team sync"
    };
    const exactCalls: Array<{ readonly eventId: string; readonly startsAt: string }> = [];
    const provider: CalendarProvider & {
      resolveExactEvent(locator: {
        readonly eventId: string;
        readonly startsAt: string;
      }): Promise<CalendarEvent | undefined>;
    } = {
      createEvent: async () => { throw new Error("not used"); },
      deleteEvent: async () => { throw new Error("not used"); },
      describe: () => ({
        credentials: [],
        description: "",
        displayName: "Google",
        id: "gcal",
        local: false
      }),
      id: "gcal",
      listEvents: async () => { throw new Error("series listing must not run"); },
      resolveExactEvent: async (locator) => {
        exactCalls.push(locator);
        return [selected, sibling].find((event) =>
          event.id === locator.eventId
          && event.startsAt.toISOString() === locator.startsAt
        );
      },
      updateEvent: async () => { throw new Error("not used"); }
    };
    const reference = encodeCalendarEventReference(selected);
    const current = state();
    await writeAttunementState(file, {
      ...current,
      threads: current.threads.map((thread) => ({
        ...thread,
        links: [{
          artifactId: reference,
          artifactType: "calendar-event" as const,
          linkedAt: "2026-07-20T00:00:00.000Z",
          linkedBy: "user" as const,
          providerId: "calendar:gcal",
          role: "context" as const,
          threadId: thread.id
        }]
      }))
    });
    const before = await readFile(file);

    const pack = await readPreparedContinuityPack(
      file,
      "thread_life",
      createCalendarExactArtifactResolver(new CalendarProviderRegistry([provider])),
      { now: () => Date.parse("2026-07-24T09:00:00.000Z") }
    );

    expect(exactCalls).toEqual([{
      eventId: selected.id,
      startsAt: selected.startsAt.toISOString()
    }]);
    expect(pack.evidence).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          artifactId: reference,
          calendarEndsAt: selected.endsAt.toISOString(),
          calendarStartsAt: selected.startsAt.toISOString(),
          providerId: "calendar:gcal",
          title: selected.title
        }),
        reference: expect.objectContaining({
          artifactId: reference,
          providerId: "calendar:gcal",
          role: "context"
        }),
        status: "available"
      })
    ]);
    const packBytes = JSON.stringify(pack);
    expect(packBytes).not.toContain(sibling.title);
    expect(packBytes).not.toContain(sibling.startsAt.toISOString());
    expect(packBytes).not.toContain(sibling.endsAt.toISOString());
    expect(pack.nextStep).toBeUndefined();
    expect(pack.interactionAnchor).toBeUndefined();
    expect(await readFile(file)).toEqual(before);
    expect((await readAttunementState(file)).deliveries).toHaveLength(0);
  });

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
    const before = await readFile(file);
    const idFactory = vi.fn(() => "must-not-run");

    await expect(openPreparedContinuityPack(file, "thread_life", async () => undefined, {
      idFactory,
      now: () => Date.parse("2026-07-18T09:00:00.000Z")
    })).rejects.toThrow(new AttunementStoreError("thread 'thread_life' has no currently available linked evidence; no delivery was recorded"));
    expect(idFactory).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
    expect((await readAttunementState(file)).deliveries).toHaveLength(0);
  });

  it.each([
    ["artifactId", (link: ArtifactLink): ResolvedArtifact => ({ ...link, artifactId: "task_other", taskStatus: "open", title: "Other task" })],
    ["artifactType", (link: ArtifactLink): ResolvedArtifact => ({ ...link, artifactType: "note", title: "Wrong type" })],
    ["providerId", (link: ArtifactLink): ResolvedArtifact => ({ ...link, providerId: "mcp:other", taskStatus: "open", title: "Wrong provider" })],
    ["role", (link: ArtifactLink): ResolvedArtifact => ({ ...link, role: "context", taskStatus: "open", title: "Wrong role" })]
  ] as const)("rejects a late %s mismatch before delivery without changing bytes or allocating an id", async (field, mutate) => {
    const file = await seededFile();
    const initial = await readAttunementState(file);
    await writeAttunementState(file, {
      ...initial,
      threads: initial.threads.map((thread) => ({ ...thread, links: [noteLink, taskLink] }))
    });
    const before = await readFile(file);
    const idFactory = vi.fn(() => "must-not-run");
    const resolved: string[] = [];

    await expect(openPreparedContinuityPack(file, "thread_life", async (link) => {
      resolved.push(link.artifactId);
      return link.artifactType === "note"
        ? { ...link, title: "Resolved context" }
        : mutate(link);
    }, { idFactory, now: () => Date.parse("2026-07-18T09:00:00.000Z") }))
      .rejects.toThrow(`exact artifact resolver returned mismatched ${field}`);

    expect(resolved).toEqual(["birthday/context.md", "task_prepare"]);
    expect(idFactory).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("propagates a late resolver failure unchanged without delivery, byte changes, or id allocation", async () => {
    const file = await seededFile();
    const initial = await readAttunementState(file);
    await writeAttunementState(file, {
      ...initial,
      threads: initial.threads.map((thread) => ({ ...thread, links: [noteLink, taskLink] }))
    });
    const before = await readFile(file);
    const idFactory = vi.fn(() => "must-not-run");
    const failure = new Error("provider unavailable");

    await expect(openPreparedContinuityPack(file, "thread_life", async (link) => {
      if (link.artifactType === "task") throw failure;
      return { ...link, title: "Resolved context" };
    }, { idFactory, now: () => Date.parse("2026-07-18T09:00:00.000Z") })).rejects.toBe(failure);

    expect(idFactory).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
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
        evidenceClass: "unclassified",
        evidenceRefs: [taskLink],
        id: "delivery_seed",
        openedAt: "2026-07-17T08:00:00.000Z",
        outcome: { evidenceClass: "unclassified", outcome: "ignored", policyVersion: 1, recordedAt: "2026-07-17T08:01:00.000Z" },
        policyVersion: 0,
        threadId: "thread_life"
      }],
      nextPolicyVersion: 2,
      threads: initial.threads.map((thread) => ({ ...thread, policy: policyForOutcome("ignored", 1) }))
    });

    await expect(openPreparedContinuityPack(file, "thread_life", async (link) => {
      await resetThreadPolicy(
        file,
        "thread_life",
        { run: (operation) => operation() },
        { idFactory: () => "race", now: () => new Date("2026-07-18T08:59:00.000Z") }
      );
      return { ...link, taskStatus: "open", title: "Choose flowers" };
    }, { now: () => Date.parse("2026-07-18T09:00:00.000Z") })).rejects.toThrow("thread policy changed while building this pack");
    expect((await readAttunementState(file)).deliveries).toHaveLength(1);
  });
});
