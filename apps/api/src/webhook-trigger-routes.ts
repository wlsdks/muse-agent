/**
 * Inbound webhook trigger for Builder flows.
 *
 * `POST /api/hooks/flows/:token` fires the ONE flow whose server-minted
 * secret matches — the token IS the auth (the route must be reachable by
 * external services that don't hold a Muse session). Fail-close posture:
 * unknown token and disabled flow are the SAME 404 (no oracle separating
 * "wrong token" from "right token, paused flow"), matching is
 * constant-time per candidate, and the secret is never logged. Unlike the
 * authenticated Run-now button (a human's explicit intent, allowed on a
 * paused job), a webhook NEVER fires a disabled flow — paused means off.
 *
 * Management (mint/rotate/revoke) lives under the normal authenticated
 * scheduler prefix; the generic PATCH parser deliberately cannot set the
 * token (server-minted only, preserved across unrelated PATCHes).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { ScheduledJob, ScheduledJobUpdateInput } from "@muse/scheduler";
import type { ServerOptions } from "./server.js";

interface WebhookTriggerRouteOptions {
  readonly requireAuthenticated: (
    request: unknown,
    reply: { status(statusCode: number): { send(payload: unknown): void } }
  ) => boolean;
  readonly scheduler: ServerOptions["scheduler"];
  /** Test seam for the per-token cooldown clock. */
  readonly nowMs?: () => number;
}

/** Minimum gap between fires of the SAME token — a leaked URL can annoy,
 * not saturate (each fire may be a full agent run on the local model). */
export const WEBHOOK_FIRE_COOLDOWN_MS = 5_000;

export function mintWebhookTriggerToken(): string {
  return `wht_${randomBytes(24).toString("base64url")}`;
}

/** Constant-time token equality; length mismatch short-circuits (length is
 * not secret — every minted token has the same shape). */
export function webhookTokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function registerWebhookTriggerRoutes(server: FastifyInstance, options: WebhookTriggerRouteOptions): void {
  const nowMs = options.nowMs ?? Date.now;
  const lastFiredAtMs = new Map<string, number>();
  server.post("/api/scheduler/jobs/:jobId/webhook-token", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }
    const service = options.scheduler?.service;
    if (!service) {
      return reply.status(503).send({ error: "DynamicScheduler not configured" });
    }
    const { jobId } = request.params as { readonly jobId: string };
    const existing = await service.findById(jobId);
    if (!existing) {
      return reply.status(404).send({ error: `Scheduled job not found: ${jobId}` });
    }
    const token = mintWebhookTriggerToken();
    await service.update(jobId, { ...jobToUpdateInput(existing), webhookTriggerToken: token });
    return { token, urlPath: `/api/hooks/flows/${token}` };
  });

  server.delete("/api/scheduler/jobs/:jobId/webhook-token", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }
    const service = options.scheduler?.service;
    if (!service) {
      return reply.status(503).send({ error: "DynamicScheduler not configured" });
    }
    const { jobId } = request.params as { readonly jobId: string };
    const existing = await service.findById(jobId);
    if (!existing) {
      return reply.status(404).send({ error: `Scheduled job not found: ${jobId}` });
    }
    await service.update(jobId, { ...jobToUpdateInput(existing), webhookTriggerToken: null });
    return reply.status(204).send(undefined);
  });

  server.post("/api/hooks/flows/:token", async (request, reply) => {
    const service = options.scheduler?.service;
    if (!service) {
      return reply.status(404).send({ error: "Not found" });
    }
    const { token } = request.params as { readonly token: string };
    if (typeof token !== "string" || !token.startsWith("wht_") || token.length > 200) {
      return reply.status(404).send({ error: "Not found" });
    }
    const jobs = await service.list();
    // Scan EVERY candidate (no early break) so a miss costs the same work
    // regardless of where a near-match sits.
    let matched: (typeof jobs)[number] | undefined;
    for (const job of jobs) {
      if (job.webhookTriggerToken && webhookTokensEqual(job.webhookTriggerToken, token)) {
        matched = job;
      }
    }
    if (!matched || !matched.enabled) {
      return reply.status(404).send({ error: "Not found" });
    }
    const previous = lastFiredAtMs.get(matched.id);
    const at = nowMs();
    if (previous !== undefined && at - previous < WEBHOOK_FIRE_COOLDOWN_MS) {
      return reply.status(429).send({ error: "Too many requests" });
    }
    lastFiredAtMs.set(matched.id, at);
    // ACK ONLY — the token grants RUN, never READ. Returning the execution
    // result here would turn a leaked trigger URL (third-party scheduler
    // logs, proxies) into an on-demand personal-data read channel; the
    // output flows solely to the owner's configured notification channel.
    await service.trigger(matched.id);
    return { fired: true, jobId: matched.id };
  });
}

/** Rebuild the full update-input a service.update needs from the stored job
 * — conditional spreads keep exactOptionalPropertyTypes honest, and keeping
 * the mapping local means the token routes can't silently drift a field. */
function jobToUpdateInput(job: ScheduledJob): ScheduledJobUpdateInput {
  return {
    cronExpression: job.cronExpression,
    enabled: job.enabled,
    jobType: job.jobType,
    maxRetryCount: job.maxRetryCount,
    name: job.name,
    retryOnFailure: job.retryOnFailure,
    tags: [...job.tags],
    timezone: job.timezone,
    toolArguments: job.toolArguments,
    ...(job.agentMaxToolCalls !== undefined ? { agentMaxToolCalls: job.agentMaxToolCalls } : {}),
    ...(job.agentModel !== undefined ? { agentModel: job.agentModel } : {}),
    ...(job.agentPrompt !== undefined ? { agentPrompt: job.agentPrompt } : {}),
    ...(job.agentSystemPrompt !== undefined ? { agentSystemPrompt: job.agentSystemPrompt } : {}),
    ...(job.description !== undefined ? { description: job.description } : {}),
    ...(job.executionTimeoutMs !== undefined ? { executionTimeoutMs: job.executionTimeoutMs } : {}),
    ...(job.mcpServerName !== undefined ? { mcpServerName: job.mcpServerName } : {}),
    ...(job.notificationChannelId !== undefined ? { notificationChannelId: job.notificationChannelId } : {}),
    ...(job.personaId !== undefined ? { personaId: job.personaId } : {}),
    ...(job.toolName !== undefined ? { toolName: job.toolName } : {}),
    ...(job.webhookTriggerToken !== undefined ? { webhookTriggerToken: job.webhookTriggerToken } : {}),
    ...(job.webhookUrl !== undefined ? { webhookUrl: job.webhookUrl } : {})
  };
}
