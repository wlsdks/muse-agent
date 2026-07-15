import { computeContinuityEvaluation, OUTCOMES, readAttunementState, recordContinuityOutcome } from "@muse/attunement";
import type { ContinuityOutcome } from "@muse/attunement";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface AttunementRoutesGate {
  readonly attunementFile: string;
  readonly authService: ServerOptions["authService"];
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
      threads: state.threads
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((thread) => ({
          id: thread.id,
          kind: thread.kind,
          linkCount: thread.links.length,
          policy: thread.policy,
          title: thread.title
        }))
    };
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
