import { realpath } from "node:fs/promises";

import { ARTIFACT_ROLES, ARTIFACT_TYPES, AttunementStoreError, buildContinuityInteractionReport, calendarProviderId, computeContinuityEvaluation, ContinuityEvaluationError, createBrowsingVisitArtifactValidator, createBrowsingVisitExactArtifactResolver, createCalendarArtifactValidator, createCalendarExactArtifactResolver, createCheckpointArtifactValidator, createCheckpointExactArtifactResolver, createContactArtifactValidator, createContactExactArtifactResolver, createConversationArtifactValidator, createConversationExactArtifactResolver, createLocalArtifactValidator, createLocalContinuityTaskInteractionSourceResolver, createLocalExactArtifactResolver, createPersonalThread, createRunArtifactValidator, createRunExactArtifactResolver, createWorkArtifactValidator, createWorkExactArtifactResolver, deletePersonalThreadWorkSafe, evaluateTimingSession, forgetTimingSession, inspectTimingSession, linkArtifact, linkWorkContinuity, OUTCOMES, pauseTimingSession, prepareContinuityReview, readAttunementState, readPreparedContinuityPack, readTimingState, recordTimingFeedback, recordTimingObservation, resetThreadPolicy, resumeTimingSession, startTimingSession, THREAD_KINDS, TIMING_APP_CATEGORIES, undoThreadReset, unlinkArtifact, unlinkWorkContinuity, type ArtifactLinkValidator, type ExactArtifactResolver } from "@muse/attunement";
import { openProductionAuthorizedContinuityPack, recordProductionAuthorizedContinuityOutcome } from "@muse/attunement/host";
import type { ContinuityOutcome, OpenPreparedContinuityPack } from "@muse/attunement";
import type { CalendarProviderRegistry } from "@muse/calendar";
import { readExactBrowsingVisit } from "@muse/recall";
import { isCanonicalWorkspaceRealpath } from "@muse/shared";
import { readExactConversation, readExactWork } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface AttunementRoutesGate {
  readonly attunementFile: string;
  readonly authService: ServerOptions["authService"];
  readonly browsingFile: string;
  readonly calendarRegistry?: CalendarProviderRegistry;
  readonly checkpointsDir: string;
  readonly contactsFile: string;
  readonly conversationsFile: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly notesDir: string;
  readonly now?: () => number;
  readonly openContinuityPack?: OpenPreparedContinuityPack;
  readonly remindersFile?: string;
  readonly tasksFile: string;
  readonly worksFile?: string;
  /** Explicit authority for workspace-scoped run evidence. No cwd fallback. */
  readonly workspaceDir?: string;
}

/** Read-only evaluation: it never resolves sources or opens a Continuity delivery. */
export function registerAttunementRoutes(server: FastifyInstance, gate: AttunementRoutesGate): void {
  const timingFile = `${gate.attunementFile}.timing.json`;
  const worksFile = gate.worksFile ?? `${gate.attunementFile}.works.json`;
  const localArtifactOptions = {
    notesDir: gate.notesDir,
    ...(gate.remindersFile ? { remindersFile: gate.remindersFile } : {}),
    tasksFile: gate.tasksFile
  };
  const validateLocal = createLocalArtifactValidator(localArtifactOptions);
  const resolveLocal = createLocalExactArtifactResolver(localArtifactOptions);
  const validateCalendar = gate.calendarRegistry ? createCalendarArtifactValidator(gate.calendarRegistry) : undefined;
  const resolveCalendar = gate.calendarRegistry ? createCalendarExactArtifactResolver(gate.calendarRegistry) : undefined;
  const validateContact = createContactArtifactValidator({ contactsFile: gate.contactsFile, ...(gate.env ? { env: gate.env } : {}) });
  const resolveContact = createContactExactArtifactResolver({ contactsFile: gate.contactsFile, ...(gate.env ? { env: gate.env } : {}) });
  const validateBrowsing = createBrowsingVisitArtifactValidator({
    readExactVisit: (artifactId) => readExactBrowsingVisit(gate.browsingFile, artifactId)
  });
  const resolveBrowsing = createBrowsingVisitExactArtifactResolver({
    readExactVisit: (artifactId) => readExactBrowsingVisit(gate.browsingFile, artifactId)
  });
  const validateConversation = createConversationArtifactValidator({
    readExactConversation: (artifactId) => readExactConversation(gate.conversationsFile, artifactId)
  });
  const resolveConversation = createConversationExactArtifactResolver({
    readExactConversation: (artifactId) => readExactConversation(gate.conversationsFile, artifactId)
  });
  const validateWork = createWorkArtifactValidator({ readExactWork: (artifactId) => readExactWork(worksFile, artifactId, gate.env) });
  const resolveWork = createWorkExactArtifactResolver({ readExactWork: (artifactId) => readExactWork(worksFile, artifactId, gate.env) });
  let workspaceRealpathPromise: Promise<string> | undefined;
  const requireWorkspaceRealpath = async (): Promise<string> => {
    if (!gate.workspaceDir) throw new AttunementStoreError("run evidence requires an explicit API workspace directory");
    workspaceRealpathPromise ??= realpath(gate.workspaceDir).then((resolved) => {
      if (!isCanonicalWorkspaceRealpath(resolved)) throw new AttunementStoreError("the explicit API workspace directory is not a valid run-evidence workspace");
      return resolved;
    }).catch((cause: unknown) => {
      if (cause instanceof AttunementStoreError) throw cause;
      throw new AttunementStoreError("the explicit API workspace directory cannot be resolved");
    });
    return workspaceRealpathPromise;
  };
  const validateArtifact: ArtifactLinkValidator = (input) => input.artifactType === "calendar-event"
    ? (validateCalendar?.(input) ?? Promise.reject(new AttunementStoreError("no calendar provider registry is configured")))
    : input.artifactType === "contact"
      ? validateContact(input)
    : input.artifactType === "run"
      ? requireWorkspaceRealpath().then((allowedWorkspaceRealpath) => createRunArtifactValidator({ allowedWorkspaceRealpath })(input))
    : input.artifactType === "checkpoint"
      ? requireWorkspaceRealpath().then((allowedWorkspaceRealpath) => createCheckpointArtifactValidator({ allowedWorkspaceRealpath, checkpointsDir: gate.checkpointsDir })(input))
    : input.artifactType === "browsing-visit"
      ? validateBrowsing(input)
    : input.artifactType === "conversation"
      ? validateConversation(input)
    : input.artifactType === "work"
      ? validateWork(input)
    : validateLocal(input);
  const resolveExactArtifact: ExactArtifactResolver = (link) => link.artifactType === "calendar-event"
    ? (resolveCalendar?.(link) ?? Promise.resolve(undefined))
    : link.artifactType === "contact"
      ? resolveContact(link)
    : link.artifactType === "run"
      ? requireWorkspaceRealpath().then((allowedWorkspaceRealpath) => createRunExactArtifactResolver({ allowedWorkspaceRealpath })(link))
    : link.artifactType === "checkpoint"
      ? requireWorkspaceRealpath().then((allowedWorkspaceRealpath) => createCheckpointExactArtifactResolver({ allowedWorkspaceRealpath, checkpointsDir: gate.checkpointsDir })(link))
    : link.artifactType === "browsing-visit"
      ? resolveBrowsing(link)
    : link.artifactType === "conversation"
      ? resolveConversation(link)
    : link.artifactType === "work"
      ? resolveWork(link)
    : resolveLocal(link);
  const assertKnownThread = async (threadId: string): Promise<void> => {
    const state = await readAttunementState(gate.attunementFile);
    if (!state.threads.some((thread) => thread.id === threadId)) throw new Error(`no personal thread with id '${threadId}'`);
  };

  server.post<{ Body: { readonly consentVersion?: unknown; readonly threadId?: unknown } }>("/api/attunement/timing/sessions", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const { consentVersion, threadId } = request.body ?? {};
    if (typeof threadId !== "string" || threadId.trim().length === 0) return reply.code(400).send({ errorMessage: "timing thread id must be a non-empty string" });
    if (typeof consentVersion !== "number" || !Number.isSafeInteger(consentVersion) || consentVersion < 1) {
      return reply.code(400).send({ errorMessage: "timing consent version must be a positive safe integer" });
    }
    return startTimingSession(timingFile, { consentVersion, threadId }, assertKnownThread);
  });

  server.get<{ Params: { readonly sessionId: string } }>("/api/attunement/timing/sessions/:sessionId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return inspectTimingSession(await readTimingState(timingFile), request.params.sessionId);
  });

  server.post<{ Params: { readonly sessionId: string } }>("/api/attunement/timing/sessions/:sessionId/pause", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return pauseTimingSession(timingFile, request.params.sessionId);
  });

  server.post<{ Params: { readonly sessionId: string } }>("/api/attunement/timing/sessions/:sessionId/resume", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return resumeTimingSession(timingFile, request.params.sessionId);
  });

  server.delete<{ Params: { readonly sessionId: string } }>("/api/attunement/timing/sessions/:sessionId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return forgetTimingSession(timingFile, request.params.sessionId);
  });

  server.post<{ Params: { readonly sessionId: string }; Body: { readonly appCategory?: unknown; readonly durationMs?: unknown; readonly endedAt?: unknown; readonly startedAt?: unknown } }>("/api/attunement/timing/sessions/:sessionId/observations", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    if (Object.keys(request.body ?? {}).some((key) => !["appCategory", "durationMs", "endedAt", "startedAt"].includes(key))) {
      return reply.code(400).send({ errorMessage: "timing observations accept category, duration, and timestamps only; raw desktop content is not accepted" });
    }
    const { appCategory, durationMs, endedAt, startedAt } = request.body ?? {};
    if (typeof appCategory !== "string" || !TIMING_APP_CATEGORIES.includes(appCategory as (typeof TIMING_APP_CATEGORIES)[number])) {
      return reply.code(400).send({ errorMessage: "timing observation app category is invalid" });
    }
    if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0 || typeof startedAt !== "string" || typeof endedAt !== "string") {
      return reply.code(400).send({ errorMessage: "timing observation requires a category, positive duration, and ISO timestamps" });
    }
    return recordTimingObservation(timingFile, request.params.sessionId, { appCategory: appCategory as (typeof TIMING_APP_CATEGORIES)[number], durationMs, endedAt, startedAt });
  });

  server.post<{ Params: { readonly sessionId: string } }>("/api/attunement/timing/sessions/:sessionId/evaluate", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const candidate = await evaluateTimingSession(timingFile, request.params.sessionId);
    if (candidate.decision !== "offer") return { candidate };
    const timing = inspectTimingSession(await readTimingState(timingFile), request.params.sessionId);
    try {
      return {
        candidate,
        pack: await readPreparedContinuityPack(
          gate.attunementFile,
          timing.session.threadId,
          resolveExactArtifact,
          gate.now ? { now: gate.now } : {}
        )
      };
    } catch (cause) {
      if (cause instanceof AttunementStoreError) return reply.code(409).send({ errorMessage: cause.message });
      throw cause;
    }
  });

  server.post<{ Params: { readonly candidateId: string }; Body: { readonly outcome?: unknown } }>("/api/attunement/timing/candidates/:candidateId/feedback", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const outcome = request.body?.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as ContinuityOutcome)) {
      return reply.code(400).send({ errorMessage: "timing feedback outcome must be used, adjusted, ignored, or rejected" });
    }
    return recordTimingFeedback(timingFile, request.params.candidateId, outcome as ContinuityOutcome);
  });

  server.get("/api/attunement/evaluation", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    try {
      return computeContinuityEvaluation(await readAttunementState(gate.attunementFile), { ...(gate.now ? { now: gate.now } : {}) });
    } catch (cause) {
      if (cause instanceof ContinuityEvaluationError) return reply.code(409).send({ errorMessage: cause.message });
      throw cause;
    }
  });

  server.get("/api/attunement/threads", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const state = await readAttunementState(gate.attunementFile);
    // A lean picker feed (id/title/kind) — the Work view links a thread by
    // PICKING it, never by typing a raw id.
    return { threads: state.threads.map((thread) => ({ id: thread.id, kind: thread.kind, title: thread.title })) };
  });

  server.get("/api/attunement/interactions", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return buildContinuityInteractionReport(
      await readAttunementState(gate.attunementFile),
      createLocalContinuityTaskInteractionSourceResolver(gate.tasksFile)
    );
  });

  server.get("/api/attunement/review", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    try {
      const state = await readAttunementState(gate.attunementFile);
      return {
        deliveries: state.deliveries
          .slice()
          .sort((left, right) => right.openedAt.localeCompare(left.openedAt))
          .map((delivery) => {
            const thread = state.threads.find((candidate) => candidate.id === delivery.threadId);
            if (!thread) throw new Error(`delivery '${delivery.id}' references a missing personal thread`);
            return {
              evidenceClass: delivery.evidenceClass,
              evidenceRefs: delivery.evidenceRefs,
              id: delivery.id,
              openedAt: delivery.openedAt,
              outcome: delivery.outcome,
              policyVersion: delivery.policyVersion,
              runId: delivery.runId,
              thread: { id: thread.id, kind: thread.kind, title: thread.title }
            };
          }),
        evaluation: computeContinuityEvaluation(state, { ...(gate.now ? { now: gate.now } : {}) }),
        reviewQueue: await prepareContinuityReview(
          state,
          resolveExactArtifact
        ),
        calendarProviders: gate.calendarRegistry?.describe().map(({ displayName, id }) => ({ displayName, id })) ?? [],
        resetReceipts: state.resetReceipts
          .slice()
          .sort((left, right) => right.resetPolicyVersion - left.resetPolicyVersion)
          .map((receipt) => ({
            id: receipt.id,
            resetPolicyVersion: receipt.resetPolicyVersion,
            threadId: receipt.threadId,
            undone: state.undoResetReceipts.some((undo) => undo.resetId === receipt.id)
          })),
        threads: state.threads
          .slice()
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((thread) => ({
            id: thread.id,
            kind: thread.kind,
            linkCount: thread.links.length,
            links: thread.links.map(({ artifactId, artifactType, providerId, role }) => ({ artifactId, artifactType, providerId, role })),
            policy: thread.policy,
            title: thread.title
          }))
      };
    } catch (cause) {
      if (cause instanceof AttunementStoreError || cause instanceof ContinuityEvaluationError) {
        return reply.code(409).send({ errorMessage: cause.message });
      }
      throw cause;
    }
  });

  server.post<{ Body: { readonly kind?: unknown; readonly title?: unknown } }>("/api/attunement/threads", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const { kind, title } = request.body ?? {};
    if (typeof title !== "string" || title.trim().length === 0) {
      return reply.code(400).send({ errorMessage: "thread title must be a non-empty string" });
    }
    if (typeof kind !== "string" || !THREAD_KINDS.includes(kind as (typeof THREAD_KINDS)[number])) {
      return reply.code(400).send({ errorMessage: "thread kind must be explicitly life or work" });
    }
    return createPersonalThread(gate.attunementFile, { kind: kind as (typeof THREAD_KINDS)[number], title });
  });

  server.post<{ Params: { readonly threadId: string }; Body: { readonly artifactId?: unknown; readonly artifactType?: unknown; readonly providerId?: unknown; readonly role?: unknown } }>("/api/attunement/threads/:threadId/links", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const { artifactId, artifactType, providerId, role } = request.body ?? {};
    if (typeof artifactId !== "string" || artifactId.trim().length === 0) return reply.code(400).send({ errorMessage: "artifact id must be a non-empty string" });
    if (typeof artifactType !== "string" || !ARTIFACT_TYPES.includes(artifactType as (typeof ARTIFACT_TYPES)[number]) || artifactType === "resource") {
      return reply.code(400).send({ errorMessage: "web linking supports validated local task, note, reminder, calendar-event, contact, run, checkpoint, browsing-visit, conversation, or Work sources only" });
    }
    if (typeof role !== "string" || !ARTIFACT_ROLES.includes(role as (typeof ARTIFACT_ROLES)[number])) return reply.code(400).send({ errorMessage: "link role must be context or next-step" });
    if (role === "next-step" && artifactType !== "task") {
      return reply.code(400).send({ errorMessage: "only a local task can be a next-step" });
    }
    if (artifactType === "calendar-event" && (typeof providerId !== "string" || !gate.calendarRegistry?.has(providerId))) {
      return reply.code(400).send({ errorMessage: "calendar-event linking requires an exact configured provider id" });
    }
    try {
      if (artifactType === "work") {
        if (role !== "context") return reply.code(400).send({ errorMessage: "Work is context-only" });
        return await linkWorkContinuity({ attunementFile: gate.attunementFile, worksFile }, {
          threadId: request.params.threadId,
          workId: artifactId
        }, { env: gate.env });
      }
      return await linkArtifact(gate.attunementFile, {
        artifactId,
        artifactType: artifactType as "task" | "note" | "reminder" | "calendar-event" | "contact" | "run" | "checkpoint" | "browsing-visit" | "conversation",
        ...(artifactType === "calendar-event" ? { providerId: calendarProviderId(providerId as string) } : {}),
        role: role as "context" | "next-step",
        threadId: request.params.threadId
      }, { validateArtifact });
    } catch (cause) {
      if (cause instanceof AttunementStoreError) return reply.code(409).send({ errorMessage: cause.message });
      throw cause;
    }
  });

  server.post<{ Params: { readonly threadId: string }; Body: { readonly artifactId?: unknown; readonly artifactType?: unknown; readonly providerId?: unknown } }>("/api/attunement/threads/:threadId/links/unlink", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const { artifactId, artifactType, providerId } = request.body ?? {};
    if (typeof artifactId !== "string" || artifactId.trim().length === 0) return reply.code(400).send({ errorMessage: "artifact id must be a non-empty string" });
    if (artifactType !== "task" && artifactType !== "note" && artifactType !== "reminder" && artifactType !== "calendar-event" && artifactType !== "contact" && artifactType !== "run" && artifactType !== "checkpoint" && artifactType !== "browsing-visit" && artifactType !== "conversation" && artifactType !== "work") return reply.code(400).send({ errorMessage: "web unlinking supports task, note, reminder, calendar-event, contact, run, checkpoint, browsing-visit, conversation, or Work sources only" });
    if (artifactType === "calendar-event" && (typeof providerId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(providerId))) {
      return reply.code(400).send({ errorMessage: "calendar-event unlinking requires the exact provider id stored on the link" });
    }
    if (artifactType === "work") {
      try {
        return { removed: await unlinkWorkContinuity({ attunementFile: gate.attunementFile, worksFile }, { threadId: request.params.threadId, workId: artifactId }, { env: gate.env }) };
      } catch (cause) {
        if (cause instanceof AttunementStoreError) return reply.code(409).send({ errorMessage: cause.message });
        throw cause;
      }
    }
    return { removed: await unlinkArtifact(gate.attunementFile, {
      artifactId,
      artifactType,
      ...(artifactType === "calendar-event" ? { providerId: calendarProviderId(providerId as string) } : {}),
      threadId: request.params.threadId
    }) };
  });

  server.post<{ Params: { readonly threadId: string } }>("/api/attunement/threads/:threadId/continue", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const state = await readAttunementState(gate.attunementFile);
    const thread = state.threads.find((candidate) => candidate.id === request.params.threadId);
    if (!thread) return reply.code(404).send({ errorMessage: "personal thread not found" });
    if (thread.links.some((link) => link.providerId.startsWith("mcp:"))) {
      return reply.code(409).send({ errorMessage: "this thread has an external resource; continue it through the CLI while its MCP connection is verified" });
    }
    try {
      const open = gate.openContinuityPack ?? openProductionAuthorizedContinuityPack;
      return await open(
        gate.attunementFile,
        thread.id,
        resolveExactArtifact,
        gate.now ? { now: gate.now } : {}
      );
    } catch (cause) {
      if (cause instanceof AttunementStoreError) {
        return reply.code(409).send({ errorMessage: cause.message });
      }
      throw cause;
    }
  });

  server.post<{ Params: { readonly threadId: string } }>("/api/attunement/threads/:threadId/reset", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return resetThreadPolicy(gate.attunementFile, request.params.threadId);
  });

  server.post<{ Params: { readonly threadId: string } }>("/api/attunement/threads/:threadId/delete", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    try {
      return await deletePersonalThreadWorkSafe({ attunementFile: gate.attunementFile, worksFile }, request.params.threadId, { env: gate.env });
    } catch (cause) {
      if (cause instanceof AttunementStoreError) return reply.code(409).send({ errorMessage: cause.message });
      throw cause;
    }
  });

  server.post<{ Params: { readonly resetId: string; readonly threadId: string } }>("/api/attunement/threads/:threadId/resets/:resetId/undo", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return undoThreadReset(gate.attunementFile, request.params.threadId, request.params.resetId);
  });

  server.post<{ Params: { readonly deliveryId: string }; Body: { readonly outcome?: unknown } }>("/api/attunement/deliveries/:deliveryId/outcome", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const outcome = request.body?.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as ContinuityOutcome)) {
      return reply.code(400).send({ errorMessage: "outcome must be used, adjusted, ignored, or rejected" });
    }
    const result = await recordProductionAuthorizedContinuityOutcome(
      gate.attunementFile,
      request.params.deliveryId,
      outcome as ContinuityOutcome,
      { ...(gate.now ? { now: () => new Date(gate.now!()) } : {}) }
    );
    return { applied: result.applied, delivery: result.delivery, policy: result.policy };
  });

  server.get<{ Params: { readonly runId: string } }>("/api/attunement/runs/:runId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const delivery = (await readAttunementState(gate.attunementFile)).deliveries
      .find((candidate) => candidate.runId === request.params.runId);
    if (!delivery) return reply.code(404).send({ error: "continuity run not found" });
    return delivery;
  });
}
