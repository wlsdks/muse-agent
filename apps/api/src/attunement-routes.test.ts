import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  setWorkContinuityThread,
  type OpenPreparedContinuityPack
} from "@muse/attunement";
import { CalendarProviderRegistry, encodeCalendarEventReference, type CalendarEvent, type CalendarProvider } from "@muse/calendar";
import { FileCheckpointStore } from "@muse/runtime-state";
import { writeBrowsingStore } from "@muse/recall";
import { encodeLocalCheckpointReference, encodeLocalRunReference } from "@muse/shared";
import { addWorkOutcome, createWork, writeContacts, writeReminders, writeTasks, type Contact, type PersistedReminder, type PersistedTask } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAttunementRoutes, type AttunementRoutesGate } from "./attunement-routes.js";

let root: string;
let attunementFile: string;
let browsingFile: string;
let contactsFile: string;
let conversationsFile: string;
let checkpointsDir: string;
let notesDir: string;
let remindersFile: string;
let tasksFile: string;
let worksFile: string;
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

const CONTACT: Contact = {
  about: "Prefers a quiet dinner",
  email: "must-not-appear@example.com",
  id: "person_김민지_Aa",
  name: "Kim Minji",
  relationship: "close friend"
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
  root = await realpath(await mkdtemp(join(tmpdir(), "muse-attunement-api-")));
  attunementFile = join(root, "attunement.json");
  browsingFile = join(root, "browsing.json");
  contactsFile = join(root, "contacts.json");
  conversationsFile = join(root, "conversations.json");
  checkpointsDir = join(root, "checkpoints");
  notesDir = join(root, "notes");
  remindersFile = join(root, "reminders.json");
  tasksFile = join(root, "tasks.json");
  worksFile = join(root, "works.json");
  await mkdir(notesDir);
  await writeTasks(tasksFile, [TASK]);
  await writeReminders(remindersFile, [REMINDER]);
  await writeContacts(contactsFile, [CONTACT]);
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
    browsingFile,
    contactsFile,
    conversationsFile,
    checkpointsDir,
    notesDir,
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
    remindersFile,
    tasksFile,
    worksFile,
    ...overrides
  });
  return app;
}

async function writeStrictRun(workspaceDir: string, runId = "run_api_exact"): Promise<string> {
  const workspaceRealpath = await realpath(workspaceDir);
  const runsDir = join(workspaceRealpath, ".muse", "runs");
  await mkdir(runsDir, { recursive: true });
  const reference = encodeLocalRunReference({ runId, workspaceRealpath });
  await writeFile(join(runsDir, `${runId}.jsonl`), `${JSON.stringify({
    apiUrl: "http://127.0.0.1:3030/private",
    grounded: "grounded",
    message: "Verify the release gate",
    model: null,
    recordedAt: "2026-07-22T00:00:00.000Z",
    response: { response: "The focused release gate passed.", secret: "must-not-appear", toolsUsed: ["task_read", "shell"] },
    runId,
    source: "cli.local",
    success: true,
    type: "chat.completed"
  })}\n`, "utf8");
  return reference;
}

async function writeStrictCheckpoint(workspaceDir: string, runId = "run_api_interrupted", step = 3): Promise<string> {
  const workspaceRealpath = await realpath(workspaceDir);
  await new FileCheckpointStore(checkpointsDir, { continuityWorkspaceDir: workspaceRealpath }).save({
    continuityEvidence: { phase: "act", query: "Continue the interrupted release review" },
    runId,
    state: { encodedMessages: ["must-not-appear"], metadata: { token: "private" }, output: "hidden", phase: "act" },
    step
  });
  return encodeLocalCheckpointReference({ runId, step, workspaceRealpath });
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

  it("links, projects, and unlinks one exact contact without exposing recipient fields", async () => {
    const app = server();
    const contactsBefore = await readFile(contactsFile);
    const linked = await app.inject({
      method: "POST",
      payload: { artifactId: CONTACT.id, artifactType: "contact", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().link).toMatchObject({ artifactId: CONTACT.id, artifactType: "contact", providerId: "local", role: "context" });

    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    const evidence = opened.json().pack.evidence.find((entry: { reference: { artifactType: string } }) => entry.reference.artifactType === "contact");
    expect(evidence).toEqual({
      artifact: {
        artifactId: CONTACT.id,
        artifactType: "contact",
        contactRelationship: CONTACT.relationship,
        providerId: "local",
        role: "context",
        summary: CONTACT.about,
        title: CONTACT.name
      },
      reference: { artifactId: CONTACT.id, artifactType: "contact", providerId: "local", role: "context" },
      status: "available"
    });
    expect(JSON.stringify(evidence)).not.toContain(CONTACT.email);

    const unlinked = await app.inject({
      method: "POST",
      payload: { artifactId: CONTACT.id, artifactType: "contact" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(unlinked.json()).toEqual({ removed: true });
    expect(await readFile(contactsFile)).toEqual(contactsBefore);
  });

  it("rejects contact names and contact next-steps before opening a delivery", async () => {
    const app = server();
    const byName = await app.inject({
      method: "POST",
      payload: { artifactId: CONTACT.name, artifactType: "contact", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(byName.statusCode).toBe(409);
    const padded = await app.inject({
      method: "POST",
      payload: { artifactId: ` ${CONTACT.id}`, artifactType: "contact", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(padded.statusCode).toBe(409);
    const nextStep = await app.inject({
      method: "POST",
      payload: { artifactId: CONTACT.id, artifactType: "contact", role: "next-step" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(nextStep.statusCode).toBe(400);
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
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
    const expected = computeContinuityEvaluation(await readAttunementState(attunementFile), { now: () => Date.parse("2026-07-17T00:00:00.000Z") });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.json()).toMatchObject({
      firstPacks: { considered: 1, rejected: 0, used: 1 },
      outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 1 },
      schemaVersion: 3
    });
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

  it("maps unavailable run workspace authority to a structured preview conflict", async () => {
    const artifactId = await writeStrictRun(root);
    const linking = server({ workspaceDir: root });
    expect((await linking.inject({
      method: "POST",
      payload: { artifactId, artifactType: "run", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(200);
    await linking.close();

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

    const response = await app.inject({ method: "POST", url: `/api/attunement/timing/sessions/${sessionId}/evaluate` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ errorMessage: "run evidence requires an explicit API workspace directory" });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
    await app.close();
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

describe("exact local run continuity sources", () => {
  it("links, safely resolves, and unlinks one exact workspace-scoped run", async () => {
    const artifactId = await writeStrictRun(root);
    const app = server({ workspaceDir: root });

    const linked = await app.inject({
      method: "POST",
      payload: { artifactId, artifactType: "run", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().link).toMatchObject({ artifactId, artifactType: "run", providerId: "local", role: "context" });

    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId,
        artifactType: "run",
        providerId: "local",
        role: "context",
        runOutcome: "grounded",
        runSuccess: true,
        runToolNames: ["task_read", "shell"],
        summary: "The focused release gate passed.",
        title: "Verify the release gate"
      }),
      status: "available"
    }));
    expect(opened.body).not.toContain("must-not-appear");
    expect(opened.body).not.toContain("127.0.0.1");

    const removed = await app.inject({
      method: "POST",
      payload: { artifactId, artifactType: "run" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(removed.json()).toEqual({ removed: true });
    await app.close();
  });

  it("fails closed without explicit workspace authority and preserves the exact raw locator", async () => {
    const artifactId = await writeStrictRun(root);
    const before = await readFile(attunementFile);
    const otherWorkspace = join(root, "other-workspace");
    await mkdir(otherWorkspace);
    for (const app of [server(), server({ workspaceDir: otherWorkspace })]) {
      const response = await app.inject({
        method: "POST",
        payload: { artifactId, artifactType: "run", role: "context" },
        url: `/api/attunement/threads/${threadId}/links`
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    }
    const padded = server({ workspaceDir: root });
    const response = await padded.inject({
      method: "POST",
      payload: { artifactId: ` ${artifactId}`, artifactType: "run", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(response.statusCode).toBe(409);
    await padded.close();
    expect(await readFile(attunementFile)).toEqual(before);
  });
});

describe("exact local browsing-visit continuity sources", () => {
  it("links, opens, and unlinks one exact visit without changing archive bytes", async () => {
    const visit = {
      id: "13390000000000000-0a1b2c3d",
      title: "Return to the travel article",
      url: "https://example.com/travel/article",
      visitedAt: "2026-07-22T01:00:00.000Z"
    };
    await writeBrowsingStore(browsingFile, {
      lastVisitTimeCursor: 13_390_000_000_000_000,
      version: 1,
      visits: [visit]
    });
    const archiveBytes = await readFile(browsingFile);
    const app = server();

    const nextStep = await app.inject({
      method: "POST",
      payload: { artifactId: visit.id, artifactType: "browsing-visit", role: "next-step" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(nextStep.statusCode).toBe(400);
    const linked = await app.inject({
      method: "POST",
      payload: { artifactId: visit.id, artifactType: "browsing-visit", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().link).toMatchObject({
      artifactId: visit.id,
      artifactType: "browsing-visit",
      providerId: "local",
      role: "context"
    });

    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId: visit.id,
        artifactType: "browsing-visit",
        browsingUrl: visit.url,
        browsingVisitedAt: visit.visitedAt,
        title: visit.title
      }),
      status: "available"
    }));

    const unlinked = await app.inject({
      method: "POST",
      payload: { artifactId: visit.id, artifactType: "browsing-visit" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(unlinked.statusCode).toBe(200);
    expect(await readFile(browsingFile)).toEqual(archiveBytes);
  });

  it("rejects an unauthenticated browsing link when local API auth is configured", async () => {
    const visit = {
      id: "13390000000000000-0a1b2c3d",
      title: "Private article",
      url: "https://example.com/private",
      visitedAt: "2026-07-22T01:00:00.000Z"
    };
    await writeBrowsingStore(browsingFile, {
      lastVisitTimeCursor: 13_390_000_000_000_000,
      version: 1,
      visits: [visit]
    });
    const response = await server({ authService: {} as never }).inject({
      method: "POST",
      payload: { artifactId: visit.id, artifactType: "browsing-visit", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });

    expect(response.statusCode).toBe(401);
    expect((await readAttunementState(attunementFile)).threads[0]?.links).toHaveLength(1);
  });

  it("rejects an unsafe browsing source before changing either store", async () => {
    const visit = {
      id: "13390000000000000-0a1b2c3d",
      title: "Unsafe destination",
      url: "javascript:alert(1)",
      visitedAt: "2026-07-22T01:00:00.000Z"
    };
    await writeBrowsingStore(browsingFile, {
      lastVisitTimeCursor: 13_390_000_000_000_000,
      version: 1,
      visits: [visit]
    });
    const attunementBytes = await readFile(attunementFile);
    const archiveBytes = await readFile(browsingFile);
    const response = await server().inject({
      method: "POST",
      payload: { artifactId: visit.id, artifactType: "browsing-visit", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().errorMessage).toContain("browsing visit URL must be absolute http(s)");
    expect(await readFile(attunementFile)).toEqual(attunementBytes);
    expect(await readFile(browsingFile)).toEqual(archiveBytes);
  });
});

describe("exact local conversation continuity sources", () => {
  it("links, opens, and unlinks only the bounded owner-prompt projection without changing archive bytes", async () => {
    const conversation = {
      createdAt: "2026-07-22T01:00:00.000Z", id: "conv_0a1b2c3d", origin: "cli", title: "Architecture consultation",
      turns: [
        { at: "2026-07-22T01:00:00.000Z", content: "Earlier", role: "user" },
        { at: "2026-07-22T01:01:00.000Z", content: "Private assistant detail", role: "assistant" },
        { at: "2026-07-22T01:02:00.000Z", content: "Choose the next safe slice", role: "user" }
      ],
      updatedAt: "2026-07-22T01:02:00.000Z"
    };
    await writeFile(conversationsFile, `${JSON.stringify({ conversations: { [conversation.id]: conversation }, version: 1 }, null, 2)}\n`);
    const archiveBytes = await readFile(conversationsFile);
    const app = server();
    expect((await app.inject({
      method: "POST", payload: { artifactId: conversation.id, artifactType: "conversation", role: "next-step" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", payload: { artifactId: conversation.id, artifactType: "conversation", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(200);
    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId: conversation.id,
        artifactType: "conversation",
        conversationLastOwnerPrompt: "Choose the next safe slice",
        conversationOrigin: "cli",
        conversationUpdatedAt: conversation.updatedAt,
        title: conversation.title
      }),
      status: "available"
    }));
    expect(JSON.stringify(opened.json())).not.toContain("Private assistant detail");
    expect((await app.inject({
      method: "POST", payload: { artifactId: conversation.id, artifactType: "conversation" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    })).statusCode).toBe(200);
    expect(await readFile(conversationsFile)).toEqual(archiveBytes);
    await app.close();
  });
});

describe("exact local Work continuity sources", () => {
  it("links, opens, and unlinks only the bounded context projection without changing Work bytes", async () => {
    const work = await createWork(worksFile, { goal: "Ship the safe slice", name: "Work continuity" }, process.env, {
      idFactory: () => "work_123e4567-e89b-4d3a-a456-426614174000",
      now: () => new Date("2026-07-22T01:00:00.000Z")
    });
    const workWithOutcome = await addWorkOutcome(
      worksFile,
      work.id,
      { kind: "used", note: "Work-local result only" },
      process.env,
      () => new Date("2026-07-22T01:30:00.000Z")
    );
    const workBytes = await readFile(worksFile);
    const app = server();
    const attunementBeforePrefix = await readFile(attunementFile);
    expect((await app.inject({
      method: "POST", payload: { artifactId: work.id.slice(0, 18), artifactType: "work", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(409);
    expect(await readFile(attunementFile)).toEqual(attunementBeforePrefix);
    expect(await readFile(worksFile)).toEqual(workBytes);
    expect((await app.inject({
      method: "POST", payload: { artifactId: work.id, artifactType: "work", role: "next-step" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", payload: { artifactId: work.id, artifactType: "work", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    })).statusCode).toBe(200);
    const beforeOpen = await readAttunementState(attunementFile);
    const feedbackBeforeOpen = beforeOpen.deliveries.filter((delivery) => delivery.outcome !== undefined);
    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId: work.id,
        artifactType: "work",
        title: work.name,
        workBoardTaskCount: 0,
        workFlowCount: 0,
        workOutcomeCount: 1,
        workStatus: "active",
        workUpdatedAt: workWithOutcome.updatedAtIso
      }),
      status: "available"
    }));
    const afterOpen = await readAttunementState(attunementFile);
    expect(afterOpen.interactionReceipts).toEqual(beforeOpen.interactionReceipts);
    expect(afterOpen.deliveries.filter((delivery) => delivery.outcome !== undefined)).toEqual(feedbackBeforeOpen);
    expect(opened.body).not.toContain("Work-local result only");
    expect(JSON.stringify(afterOpen)).not.toContain("Work-local result only");
    expect((await app.inject({
      method: "POST", payload: { artifactId: work.id, artifactType: "work" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    })).statusCode).toBe(200);
    expect(await readFile(worksFile)).toEqual(workBytes);
    await setWorkContinuityThread({ attunementFile, worksFile }, { threadId, workId: work.id });
    const rejectedDelete = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/delete` });
    expect(rejectedDelete.statusCode).toBe(409);
    expect(rejectedDelete.json().errorMessage).toContain("clear it first");
    await app.close();
  });
});

describe("exact local checkpoint continuity sources", () => {
  it("links, safely resolves, and unlinks one future workspace-scoped checkpoint", async () => {
    const artifactId = await writeStrictCheckpoint(root);
    const app = server({ workspaceDir: root });
    const linked = await app.inject({
      method: "POST",
      payload: { artifactId, artifactType: "checkpoint", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().link).toMatchObject({ artifactId, artifactType: "checkpoint", providerId: "local", role: "context" });

    const opened = await app.inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().pack.evidence).toContainEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        artifactId,
        artifactType: "checkpoint",
        checkpointPhase: "act",
        checkpointStep: 3,
        providerId: "local",
        role: "context",
        title: "Continue the interrupted release review"
      }),
      status: "available"
    }));
    expect(opened.body).not.toContain("must-not-appear");
    expect(opened.body).not.toContain("private");
    expect(opened.json().pack.nextStep?.artifactType).toBe("task");

    const removed = await app.inject({
      method: "POST",
      payload: { artifactId, artifactType: "checkpoint" },
      url: `/api/attunement/threads/${threadId}/links/unlink`
    });
    expect(removed.json()).toEqual({ removed: true });
    await app.close();
  });

  it("fails closed without explicit workspace authority and preserves padded locators", async () => {
    const artifactId = await writeStrictCheckpoint(root, "run_api_blocked", 2);
    const before = await readFile(attunementFile);
    for (const app of [server(), server({ workspaceDir: await realpath(await mkdtemp(join(root, "other-"))) })]) {
      const response = await app.inject({
        method: "POST",
        payload: { artifactId, artifactType: "checkpoint", role: "context" },
        url: `/api/attunement/threads/${threadId}/links`
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    }
    const app = server({ workspaceDir: root });
    const padded = await app.inject({
      method: "POST",
      payload: { artifactId: ` ${artifactId}`, artifactType: "checkpoint", role: "context" },
      url: `/api/attunement/threads/${threadId}/links`
    });
    expect(padded.statusCode).toBe(409);
    await app.close();
    expect(await readFile(attunementFile)).toEqual(before);
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
