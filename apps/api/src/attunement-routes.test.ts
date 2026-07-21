import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttunementStoreError,
  computeContinuityEvaluation,
  createLocalArtifactValidator,
  createLocalExactArtifactResolver,
  createPersonalThread,
  linkArtifact,
  prepareContinuityReview,
  readAttunementState,
  type OpenPreparedContinuityPack
} from "@muse/attunement";
import { CalendarProviderRegistry, encodeCalendarEventReference, type CalendarEvent, type CalendarProvider } from "@muse/calendar";
import { writeReminders, writeTasks, type PersistedReminder, type PersistedTask } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAttunementRoutes, type AttunementRoutesGate } from "./attunement-routes.js";

let root: string;
let attunementFile: string;
let notesDir: string;
let remindersFile: string;
let tasksFile: string;
let threadId: string;

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-16T10:00:00.000Z",
  id: "task_api_prepare",
  notes: "  Ask Jamie which flowers they prefer.\nThen send matching options.  ",
  status: "open",
  tags: ["birthday", "Jamie"],
  title: "Send flower options"
};

const REMINDER: PersistedReminder = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-16T09:00:00.000Z",
  id: "reminder_api_dentist",
  status: "pending",
  text: "Bring the referral letter"
};

const CALENDAR_EVENT: CalendarEvent = {
  allDay: false,
  endsAt: new Date("2026-07-18T10:00:00.000Z"),
  id: "event_api_review",
  location: "Studio 2",
  notes: "Bring the private attendee roster, but only this summary is projected.",
  providerId: "work-calendar",
  startsAt: new Date("2026-07-18T09:00:00.000Z"),
  title: "Portfolio review"
};

function calendarRegistry(): CalendarProviderRegistry {
  const provider: CalendarProvider & { resolveExactEvent(locator: { readonly eventId: string; readonly startsAt: string }): Promise<CalendarEvent | undefined> } = {
    createEvent: async () => CALENDAR_EVENT,
    deleteEvent: async () => undefined,
    describe: () => ({ credentials: [], description: "Work calendar", displayName: "Work", id: "work-calendar", local: true }),
    id: "work-calendar",
    listEvents: async () => [CALENDAR_EVENT],
    resolveExactEvent: async (locator) => locator.eventId === CALENDAR_EVENT.id && locator.startsAt === CALENDAR_EVENT.startsAt.toISOString() ? CALENDAR_EVENT : undefined,
    updateEvent: async () => CALENDAR_EVENT
  };
  return new CalendarProviderRegistry([provider]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-attunement-api-"));
  attunementFile = join(root, "attunement.json");
  notesDir = join(root, "notes");
  remindersFile = join(root, "reminders.json");
  tasksFile = join(root, "tasks.json");
  await mkdir(notesDir);
  await writeTasks(tasksFile, [TASK]);
  await writeReminders(remindersFile, [REMINDER]);
  const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Prepare birthday" }, {
    idFactory: () => "api",
    now: () => new Date("2026-07-14T00:00:00.000Z")
  });
  threadId = thread.id;
  await linkArtifact(attunementFile, {
    artifactId: TASK.id,
    artifactType: "task",
    role: "next-step",
    threadId
  }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function server(overrides: Partial<AttunementRoutesGate> = {}) {
  const app = Fastify();
  registerAttunementRoutes(app, {
    attunementFile,
    authService: undefined,
    notesDir,
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
    remindersFile,
    tasksFile,
    ...overrides
  });
  return app;
}

describe("POST /api/attunement/threads/:threadId/continue", () => {
  it("keeps missing threads at a structured 404", async () => {
    const response = await server().inject({ method: "POST", url: "/api/attunement/threads/thread_missing/continue" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ errorMessage: "personal thread not found" });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });

  it("keeps externally linked threads at a structured 409 for CLI resolution", async () => {
    await linkArtifact(attunementFile, {
      artifactId: "github/example/issues/1",
      artifactType: "resource",
      providerId: "mcp:github",
      role: "context",
      threadId
    }, {
      validateArtifact: async ({ artifactId, artifactType, providerId }) => ({ artifactId, artifactType, providerId })
    });
    const response = await server().inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      errorMessage: "this thread has an external resource; continue it through the CLI while its MCP connection is verified"
    });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });

  it("returns the canonical prepared task metadata and records one delivery", async () => {
    const response = await server().inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.delivery.evidenceClass).toBe("organic");
    expect(body.pack.nextStep).toMatchObject({
      summary: "Ask Jamie which flowers they prefer. Then send matching options.",
      taskDueAt: TASK.dueAt,
      taskDueState: "overdue",
      taskStatus: "open",
      taskTags: TASK.tags
    });
    expect(body.pack.evidence[0].reference).toEqual({
      artifactId: TASK.id,
      artifactType: "task",
      providerId: "local",
      role: "next-step"
    });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(1);
    const beforeInteractions = await readFile(attunementFile, "utf8");
    const interactions = await server().inject({ method: "GET", url: "/api/attunement/interactions" });
    expect(interactions.statusCode).toBe(200);
    expect(interactions.json().digest).toMatchObject({
      byThreadKind: { life: { totalDeliveries: 1 }, work: { totalDeliveries: 0 } },
      overall: { states: { none: { count: 1 } }, totalDeliveries: 1 }
    });
    expect(interactions.json().audit).toMatchObject({
      byThreadKind: {
        life: { distinctUtcOpenedDates: 0, exactInteractions: 0, remainingDates: 2, remainingExactInteractions: 10 },
        work: { distinctUtcOpenedDates: 0, exactInteractions: 0, remainingDates: 2, remainingExactInteractions: 10 }
      },
      status: "collecting"
    });
    expect(interactions.json().interactions).toContainEqual(expect.objectContaining({
      deliveryId: body.delivery.id,
      interaction: expect.objectContaining({ state: "none" })
    }));
    expect(await readFile(attunementFile, "utf8")).toBe(beforeInteractions);
  });

  it("links, projects, reviews, and unlinks one exact reminder without mutating reminder bytes", async () => {
    const app = server();
    const reminderBefore = await readFile(remindersFile);
    const linked = await app.inject({
      method: "POST",
      payload: { artifactId: "reminder_api_d", artifactType: "reminder", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().link).toMatchObject({ artifactId: REMINDER.id, artifactType: "reminder", role: "context" });
    expect(await readFile(remindersFile)).toEqual(reminderBefore);

    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId: REMINDER.id,
        reminderDueAt: REMINDER.dueAt,
        reminderDueState: "overdue",
        reminderStatus: "pending",
        title: REMINDER.text
      }),
      reference: { artifactId: REMINDER.id, artifactType: "reminder", providerId: "local", role: "context" },
      status: "available"
    }));

    const attunementBeforeReview = await readFile(attunementFile);
    const review = await app.inject({ method: "GET", url: "/api/attunement/review" });
    expect(review.statusCode).toBe(200);
    expect(review.json().reviewQueue.next.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({ artifactId: REMINDER.id, reminderStatus: "pending" })
    }));
    expect(await readFile(attunementFile)).toEqual(attunementBeforeReview);
    expect(await readFile(remindersFile)).toEqual(reminderBefore);

    const unlinked = await app.inject({
      method: "POST",
      payload: { artifactId: REMINDER.id, artifactType: "reminder" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json()).toEqual({ removed: true });
    expect(await readFile(remindersFile)).toEqual(reminderBefore);
  });

  it("rejects a reminder next-step before reading or writing either store", async () => {
    const attunementBefore = await readFile(attunementFile);
    const reminderBefore = await readFile(remindersFile);
    const response = await server().inject({
      method: "POST",
      payload: { artifactId: REMINDER.id, artifactType: "reminder", role: "next-step" },
      url: `/api/attunement/threads/${threadId}/links`
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ errorMessage: "only a local task can be a next-step" });
    expect(await readFile(attunementFile)).toEqual(attunementBefore);
    expect(await readFile(remindersFile)).toEqual(reminderBefore);
  });

  it("maps an unavailable reminder store to a structured conflict without opening a delivery", async () => {
    const app = server();
    const linked = await app.inject({
      method: "POST",
      payload: { artifactId: REMINDER.id, artifactType: "reminder", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    await writeFile(remindersFile, "{");
    const attunementBefore = await readFile(attunementFile);
    const reminderBefore = await readFile(remindersFile);

    const response = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ errorMessage: "reminder store cannot be read or validated" });
    expect(await readFile(attunementFile)).toEqual(attunementBefore);
    expect(await readFile(remindersFile)).toEqual(reminderBefore);
  });

  it("maps unavailable preparation to a structured 409 without a delivery", async () => {
    await writeTasks(tasksFile, []);
    const response = await server().inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ errorMessage: expect.stringContaining("no currently available linked evidence") });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });

  it("maps a preparation policy race to a structured 409 without a delivery", async () => {
    const openContinuityPack: OpenPreparedContinuityPack = async () => {
      throw new AttunementStoreError("thread policy changed while building this pack; rebuild before opening it");
    };
    const response = await server({ openContinuityPack }).inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ errorMessage: "thread policy changed while building this pack; rebuild before opening it" });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });
});

describe("GET /api/attunement/review", () => {
  it("returns the shared oldest-pending exact review without mutating persisted state", async () => {
    const app = server();
    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    const deliveryId = opened.json().delivery.id as string;
    const before = await readFile(attunementFile);

    const response = await app.inject({ method: "GET", url: "/api/attunement/review" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reviewQueue).toEqual({
      next: {
        deliveryId,
        evidence: [{
          artifact: expect.objectContaining({ artifactId: TASK.id, title: TASK.title }),
          reference: { artifactId: TASK.id, artifactType: "task", providerId: "local", role: "next-step" },
          status: "available"
        }],
        openedAt: "2026-07-17T00:00:00.000Z",
        thread: { id: threadId, kind: "life", title: "Prepare birthday" }
      },
      progress: {
        eligibleDeliveries: 1,
        remainingFeedback: 1,
        remainingPacks: 19,
        reviewedDeliveries: 0,
        target: 20
      }
    });
    expect(body.reviewQueue).toEqual(await prepareContinuityReview(
      await readAttunementState(attunementFile),
      createLocalExactArtifactResolver({ notesDir, tasksFile })
    ));
    expect(await readFile(attunementFile)).toEqual(before);
  });

  it("returns a structured conflict instead of a complete-looking queue for a missing delivery thread", async () => {
    const app = server();
    await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    const corrupt = JSON.parse(await readFile(attunementFile, "utf8")) as { threads: unknown[] };
    corrupt.threads = [];
    await writeFile(attunementFile, `${JSON.stringify(corrupt)}\n`);

    const response = await app.inject({ method: "GET", url: "/api/attunement/review" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ errorMessage: expect.stringMatching(/delivery '.+' references a missing thread/u) });
    expect(response.json()).not.toHaveProperty("reviewQueue");
  });

  it("advances every canonical reader to the other pending delivery after one explicit outcome", async () => {
    const app = server();
    const openedIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
      openedIds.push(opened.json().delivery.id as string);
    }
    const before = await app.inject({ method: "GET", url: "/api/attunement/review" });
    const firstPending = before.json().reviewQueue.next.deliveryId as string;

    const recorded = await app.inject({
      method: "POST",
      payload: { outcome: "used" },
      url: `/api/attunement/deliveries/${firstPending}/outcome`
    });
    const after = await app.inject({ method: "GET", url: "/api/attunement/review" });
    const expectedNext = openedIds.find((id) => id !== firstPending);

    expect(recorded.statusCode).toBe(200);
    expect(after.json().reviewQueue.next.deliveryId).toBe(expectedNext);
    expect(after.json().deliveries.find((delivery: { id: string }) => delivery.id === firstPending)).toMatchObject({
      evidenceClass: "organic",
      outcome: { evidenceClass: "organic", outcome: "used" }
    });
    expect(after.json().reviewQueue.progress).toMatchObject({ remainingFeedback: 1, reviewedDeliveries: 1 });
    expect(after.json().reviewQueue).toEqual(await prepareContinuityReview(
      await readAttunementState(attunementFile),
      createLocalExactArtifactResolver({ notesDir, tasksFile })
    ));
  });
});

describe("GET /api/attunement/evaluation integrity", () => {
  it("returns the exact shared longitudinal gate", async () => {
    const app = server();
    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    const deliveryId = opened.json().delivery.id as string;
    await app.inject({
      method: "POST",
      payload: { outcome: "used" },
      url: `/api/attunement/deliveries/${deliveryId}/outcome`
    });

    const response = await app.inject({ method: "GET", url: "/api/attunement/evaluation" });
    const expected = computeContinuityEvaluation(await readAttunementState(attunementFile));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.json().longitudinalGate).toMatchObject({
      byKind: { life: { distinctUtcDates: 1, explicitFeedback: 1, remainingFeedback: 9 } },
      status: "collecting"
    });
  });

  it.each(["/api/attunement/evaluation", "/api/attunement/review"])("maps malformed timestamps to the same structured conflict at %s", async (url) => {
    const app = server();
    await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    const corrupt = JSON.parse(await readFile(attunementFile, "utf8")) as { deliveries: Array<{ id: string; openedAt: string }> };
    const deliveryId = corrupt.deliveries[0]!.id;
    corrupt.deliveries[0]!.openedAt = "not-a-timestamp";
    await writeFile(attunementFile, `${JSON.stringify(corrupt)}\n`);

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ errorMessage: `delivery '${deliveryId}' has an invalid openedAt timestamp` });
    expect(response.json()).not.toHaveProperty("evaluation");
    expect(response.json()).not.toHaveProperty("reviewQueue");
  });
});

describe("POST /api/attunement/timing/sessions/:sessionId/evaluate", () => {
  it("previews an offer through preparation without opening a delivery", async () => {
    const app = server();
    const started = await app.inject({
      method: "POST",
      payload: { consentVersion: 1, threadId },
      url: "/api/attunement/timing/sessions"
    });
    const sessionId = started.json().id as string;
    for (const observation of [
      { appCategory: "building", endedAt: "2026-07-17T09:25:00.000Z", startedAt: "2026-07-17T09:00:00.000Z" },
      { appCategory: "planning", endedAt: "2026-07-17T09:50:00.000Z", startedAt: "2026-07-17T09:25:00.000Z" }
    ]) {
      await app.inject({
        method: "POST",
        payload: { ...observation, durationMs: 25 * 60_000 },
        url: `/api/attunement/timing/sessions/${sessionId}/observations`
      });
    }

    const before = (await readAttunementState(attunementFile)).deliveries.length;
    const evaluated = await app.inject({ method: "POST", url: `/api/attunement/timing/sessions/${sessionId}/evaluate` });
    const after = (await readAttunementState(attunementFile)).deliveries.length;

    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json()).toMatchObject({ candidate: { decision: "offer" }, pack: { nextStep: { taskDueState: "overdue" } } });
    expect(after).toBe(before);
  });
});

describe("GET /api/attunement/threads — the Work view's thread-picker feed", () => {
  it("returns each thread's id/title/kind and nothing else (lean picker rows)", async () => {
    const app = server();
    const res = await app.inject({ method: "GET", url: "/api/attunement/threads" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { threads: readonly Record<string, unknown>[] };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toEqual({ id: threadId, kind: "life", title: "Prepare birthday" });
    await app.close();
  });
});

describe("calendar-event continuity sources", () => {
  it("lists configured providers and links, resolves, and unlinks one exact occurrence", async () => {
    const registry = calendarRegistry();
    const app = server({ calendarRegistry: registry });
    const artifactId = encodeCalendarEventReference(CALENDAR_EVENT);

    const before = await app.inject({ method: "GET", url: "/api/attunement/review" });
    expect(before.json().calendarProviders).toEqual([{ displayName: "Work", id: "work-calendar" }]);

    const linked = await app.inject({
      method: "POST",
      payload: { artifactId, artifactType: "calendar-event", providerId: "work-calendar", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().link).toMatchObject({ artifactId, artifactType: "calendar-event", providerId: "calendar:work-calendar", role: "context" });

    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId,
        artifactType: "calendar-event",
        calendarLocation: "Studio 2",
        calendarStartsAt: CALENDAR_EVENT.startsAt.toISOString(),
        calendarTimeState: "upcoming",
        providerId: "calendar:work-calendar",
        role: "context",
        title: "Portfolio review"
      }),
      status: "available"
    }));

    const removed = await app.inject({
      method: "POST",
      payload: { artifactId, artifactType: "calendar-event", providerId: "work-calendar" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(removed.json()).toEqual({ removed: true });
    expect((await readAttunementState(attunementFile)).threads[0]?.links).not.toContainEqual(expect.objectContaining({ artifactId }));
    await app.close();
  });

  it("rejects missing and unregistered providers without writing a link", async () => {
    const app = server({ calendarRegistry: calendarRegistry() });
    const artifactId = encodeCalendarEventReference(CALENDAR_EVENT);
    for (const providerId of [undefined, "guessed-calendar"]) {
      const response = await app.inject({
        method: "POST",
        payload: { artifactId, artifactType: "calendar-event", ...(providerId ? { providerId } : {}), role: "context" },
        url: `/api/attunement/threads/${threadId}/links`
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await readAttunementState(attunementFile)).threads[0]?.links).toHaveLength(1);
    await app.close();
  });

  it("can unlink stale calendar context after its provider is removed", async () => {
    const artifactId = encodeCalendarEventReference(CALENDAR_EVENT);
    const linkedApp = server({ calendarRegistry: calendarRegistry() });
    expect((await linkedApp.inject({
      method: "POST",
      payload: { artifactId, artifactType: "calendar-event", providerId: "work-calendar", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(200);
    await linkedApp.close();

    const removedApp = server({ calendarRegistry: new CalendarProviderRegistry() });
    const removed = await removedApp.inject({
      method: "POST",
      payload: { artifactId, artifactType: "calendar-event", providerId: "work-calendar" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(removed.json()).toEqual({ removed: true });
    await removedApp.close();
  });
});
