import { ARTIFACT_ROLES, ARTIFACT_TYPES, buildContinuityPack, computeContinuityEvaluation, createLocalArtifactValidator, createLocalExactArtifactResolver, createPersonalThread, deletePersonalThread, linkArtifact, openContinuityDelivery, OUTCOMES, readAttunementState, recordContinuityOutcome, resetThreadPolicy, THREAD_KINDS, undoThreadReset, unlinkArtifact } from "@muse/attunement";
import type { ContinuityOutcome } from "@muse/attunement";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface AttunementRoutesGate {
  readonly attunementFile: string;
  readonly authService: ServerOptions["authService"];
  readonly notesDir: string;
  readonly tasksFile: string;
}

/** Read-only evaluation: it never resolves sources or opens a Continuity delivery. */
export function registerAttunementRoutes(server: FastifyInstance, gate: AttunementRoutesGate): void {
  server.get("/api/attunement/evaluation", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return computeContinuityEvaluation(await readAttunementState(gate.attunementFile));
  });

  server.get("/api/attunement/review", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const state = await readAttunementState(gate.attunementFile);
    return {
      deliveries: state.deliveries
        .slice()
        .sort((left, right) => right.openedAt.localeCompare(left.openedAt))
        .map((delivery) => {
          const thread = state.threads.find((candidate) => candidate.id === delivery.threadId);
          if (!thread) throw new Error(`delivery '${delivery.id}' references a missing personal thread`);
          return {
            evidenceRefs: delivery.evidenceRefs,
            id: delivery.id,
            openedAt: delivery.openedAt,
            outcome: delivery.outcome,
            policyVersion: delivery.policyVersion,
            runId: delivery.runId,
            thread: { id: thread.id, kind: thread.kind, title: thread.title }
          };
        }),
      evaluation: computeContinuityEvaluation(state),
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

  server.post<{ Params: { readonly threadId: string }; Body: { readonly artifactId?: unknown; readonly artifactType?: unknown; readonly role?: unknown } }>("/api/attunement/threads/:threadId/links", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const { artifactId, artifactType, role } = request.body ?? {};
    if (typeof artifactId !== "string" || artifactId.trim().length === 0) return reply.code(400).send({ errorMessage: "artifact id must be a non-empty string" });
    if (typeof artifactType !== "string" || !ARTIFACT_TYPES.includes(artifactType as (typeof ARTIFACT_TYPES)[number]) || artifactType === "resource") {
      return reply.code(400).send({ errorMessage: "web linking supports validated local task or note sources only" });
    }
    if (typeof role !== "string" || !ARTIFACT_ROLES.includes(role as (typeof ARTIFACT_ROLES)[number])) return reply.code(400).send({ errorMessage: "link role must be context or next-step" });
    return linkArtifact(gate.attunementFile, {
      artifactId,
      artifactType: artifactType as "task" | "note",
      role: role as "context" | "next-step",
      threadId: request.params.threadId
    }, { validateArtifact: createLocalArtifactValidator({ notesDir: gate.notesDir, tasksFile: gate.tasksFile }) });
  });

  server.post<{ Params: { readonly threadId: string }; Body: { readonly artifactId?: unknown; readonly artifactType?: unknown } }>("/api/attunement/threads/:threadId/links/unlink", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const { artifactId, artifactType } = request.body ?? {};
    if (typeof artifactId !== "string" || artifactId.trim().length === 0) return reply.code(400).send({ errorMessage: "artifact id must be a non-empty string" });
    if (artifactType !== "task" && artifactType !== "note") return reply.code(400).send({ errorMessage: "web unlinking supports local task or note sources only" });
    return { removed: await unlinkArtifact(gate.attunementFile, { artifactId, artifactType, threadId: request.params.threadId }) };
  });

  server.post<{ Params: { readonly threadId: string } }>("/api/attunement/threads/:threadId/continue", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    const state = await readAttunementState(gate.attunementFile);
    const thread = state.threads.find((candidate) => candidate.id === request.params.threadId);
    if (!thread) return reply.code(404).send({ errorMessage: "personal thread not found" });
    if (thread.links.some((link) => link.providerId !== "local")) {
      return reply.code(409).send({ errorMessage: "this thread has an external resource; continue it through the CLI while its MCP connection is verified" });
    }
    const pack = await buildContinuityPack(state, thread.id, createLocalExactArtifactResolver({ notesDir: gate.notesDir, tasksFile: gate.tasksFile }));
    if (!pack.evidence.some((entry) => entry.status === "available")) {
      return reply.code(409).send({ errorMessage: "this thread has no currently available linked evidence" });
    }
    const delivery = await openContinuityDelivery(gate.attunementFile, {
      evidenceRefs: pack.evidenceRefs,
      expectedPolicyVersion: pack.deliveryPolicyVersion,
      threadId: thread.id
    });
    return { delivery, pack };
  });

  server.post<{ Params: { readonly threadId: string } }>("/api/attunement/threads/:threadId/reset", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return resetThreadPolicy(gate.attunementFile, request.params.threadId);
  });

  server.post<{ Params: { readonly threadId: string } }>("/api/attunement/threads/:threadId/delete", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) return reply;
    return deletePersonalThread(gate.attunementFile, request.params.threadId);
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
    const result = await recordContinuityOutcome(gate.attunementFile, request.params.deliveryId, outcome as ContinuityOutcome);
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
