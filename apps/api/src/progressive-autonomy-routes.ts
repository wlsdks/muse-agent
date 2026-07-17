import {
  ProgressiveAutonomyOpportunityReviewService,
  type ProgressiveAutonomyOpportunityReviewServiceOptions
} from "@muse/autoconfigure";
import type { MuseAuth } from "@muse/auth";
import {
  ProgressiveAutonomyOpportunityReviewConflictError,
  ProgressiveAutonomyOpportunityStoreCorruptError
} from "@muse/stores/host-progressive-autonomy-opportunities";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getAuthIdentity, requireAuthenticated } from "./server-helpers.js";

export interface ProgressiveAutonomyRoutesOptions extends Omit<
  ProgressiveAutonomyOpportunityReviewServiceOptions,
  "ownerUserId"
> {
  readonly authService?: MuseAuth;
  readonly defaultUserId: string;
}

export function registerProgressiveAutonomyRoutes(
  server: FastifyInstance,
  options: ProgressiveAutonomyRoutesOptions
): void {
  server.get("/api/autonomy/review", async (request, reply) => {
    const ownerUserId = resolveOwner(request, reply, options);
    if (!ownerUserId) return;
    if (containsIdentityInput(request.query)) {
      return reply.status(400).send({ error: "request identity is not accepted" });
    }
    try {
      const opportunity = await service(options, ownerUserId).review();
      return reply.send({ opportunity: opportunity ?? null, schemaVersion: 1 });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  server.post("/api/autonomy/opportunities/:opportunityId/decision", async (request, reply) => {
    const ownerUserId = resolveOwner(request, reply, options);
    if (!ownerUserId) return;
    const body = request.body;
    if (!isDecisionBody(body) || containsIdentityInput(request.query)) {
      return reply.status(400).send({ error: "invalid progressive autonomy decision input" });
    }
    const opportunityId = (request.params as { readonly opportunityId?: unknown }).opportunityId;
    if (typeof opportunityId !== "string" || opportunityId.trim().length === 0) {
      return reply.status(400).send({ error: "opportunity id is required" });
    }
    try {
      const review = await service(options, ownerUserId).decide(opportunityId, {
        decision: body.decision,
        ...(body.reason === undefined ? {} : { reason: body.reason })
      });
      return reply.send({ review, schemaVersion: 1 });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });
}

function resolveOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProgressiveAutonomyRoutesOptions
): string | undefined {
  if (options.authService) {
    if (!requireAuthenticated(request, reply, true)) return undefined;
    return getAuthIdentity(request)?.userId;
  }
  if (!isNormalizedLoopback(request.ip)) {
    reply.status(403).send({ error: "progressive autonomy review is loopback-only without authentication" });
    return undefined;
  }
  return options.defaultUserId;
}

export function isNormalizedLoopback(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function service(options: ProgressiveAutonomyRoutesOptions, ownerUserId: string) {
  return new ProgressiveAutonomyOpportunityReviewService({
    attunementFile: options.attunementFile,
    ...(options.now ? { now: options.now } : {}),
    opportunitiesFile: options.opportunitiesFile,
    ownerUserId,
    tasksFile: options.tasksFile
  });
}

function containsIdentityInput(value: unknown): boolean {
  return isRecord(value) && ["evidenceClass", "ownerUserId", "userId"].some((key) => key in value);
}

function isDecisionBody(value: unknown): value is {
  readonly decision: "needs-adjustment" | "would-approve" | "would-deny";
  readonly reason?: string;
} {
  if (!isRecord(value) || containsIdentityInput(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === "decision" || key === "reason")) return false;
  if (value.decision !== "would-approve" && value.decision !== "would-deny" && value.decision !== "needs-adjustment") return false;
  return value.reason === undefined || typeof value.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProgressiveAutonomyOpportunityStoreCorruptError) {
    return reply.status(500).send({ error: error.message });
  }
  if (error instanceof ProgressiveAutonomyOpportunityReviewConflictError) {
    return reply.status(409).send({ error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("does not exist")) return reply.status(404).send({ error: message });
  if (message.includes("different user")) return reply.status(403).send({ error: message });
  if (message.includes("requires exact") || message.includes("unavailable")) {
    return reply.status(409).send({ error: message });
  }
  return reply.status(400).send({ error: message });
}
