// Admin run-history + injection-counter registrars — split out of server-routes.ts (domain cohesion).

import type { AgentSpecRegistry } from "@muse/agent-specs";
import type { RuntimeSettings } from "@muse/runtime-settings";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated, toAdminRunSummary } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface AdminGate {
  readonly authService: ServerOptions["authService"];
}

export function registerAdminRunRoutes(
  server: FastifyInstance,
  options: ServerOptions,
  agentSpecRegistry: AgentSpecRegistry,
  runtimeSettings: RuntimeSettings,
  gate: AdminGate
): void {
  server.get("/admin/summary", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    const [agentSpecs, settings, scheduledJobs, recentRuns] = await Promise.all([
      agentSpecRegistry.list(),
      runtimeSettings.list(),
      options.scheduler?.store.list() ?? [],
      options.historyStore?.listRuns({ limit: 5 }) ?? []
    ]);

    return {
      agentSpecCount: agentSpecs.length,
      authEnabled: Boolean(gate.authService),
      recentRuns: recentRuns.map(toAdminRunSummary),
      runtimeSettingCount: settings.length,
      schedulerJobCount: scheduledJobs.length
    };
  });

  server.get("/admin/users/:userId/runs", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const { userId } = request.params as { readonly userId: string };
    return options.historyStore.listRunsByUser(userId);
  });

  const findRunDetail = async (request: unknown, reply: { status(statusCode: number): { send(payload: unknown): void } }, runId: string) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const run = await options.historyStore.findRun(runId);

    if (!run) {
      return reply.status(404).send({
        code: "RUN_NOT_FOUND",
        message: `Run not found: ${runId}`
      });
    }

    const [messages, toolCalls] = await Promise.all([
      options.historyStore.listMessages(runId),
      options.historyStore.listToolCalls(runId)
    ]);
    return { messages, run, toolCalls };
  };

  server.get("/admin/runs/:runId", async (request, reply) => {
    return findRunDetail(request, reply, (request.params as { readonly runId: string }).runId);
  });

  server.get("/api/admin/runs/:runId", async (request, reply) => {
    return findRunDetail(request, reply, (request.params as { readonly runId: string }).runId);
  });

  server.get("/api/admin/runs", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const limitRaw = (request.query as { readonly limit?: string } | undefined)?.limit;
    let limit: number | undefined;

    if (limitRaw !== undefined) {
      const trimmed = limitRaw.trim();
      const parsed = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
        return reply.status(400).send({
          code: "INVALID_LIMIT",
          message: "limit must be an integer between 0 and 1000"
        });
      }
      limit = parsed;
    }

    const runs = await options.historyStore.listRuns(limit !== undefined ? { limit } : {});
    return {
      entries: runs.map(toAdminRunSummary),
      total: runs.length
    };
  });

  // DELETE a single run by id, or bulk by ?before=<iso>.
  server.delete("/api/admin/runs/:runId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }
    const { runId } = request.params as { readonly runId: string };
    const deleted = await options.historyStore.deleteRun(runId);
    if (!deleted) {
      return reply.status(404).send({
        code: "RUN_NOT_FOUND",
        message: `Run not found: ${runId}`
      });
    }
    return { deleted: true, runId };
  });

  server.delete("/api/admin/runs", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }
    const before = (request.query as { readonly before?: string } | undefined)?.before;
    if (!before) {
      return reply.status(400).send({
        code: "MISSING_BEFORE",
        message: "?before=<iso> is required for bulk delete"
      });
    }
    const parsed = Date.parse(before);
    if (!Number.isFinite(parsed)) {
      return reply.status(400).send({
        code: "INVALID_BEFORE",
        message: `before must be a parseable ISO timestamp (got '${before}')`
      });
    }
    // Read up to a generous cap, filter by cutoff, then delete one
    // by one. The InMemory store enforces a max-entries cap and the
    // Kysely store paginates; both honor the request limit so this
    // approach stays bounded even when no `--before` is set.
    const runs = await options.historyStore.listRuns({ limit: 1_000 });
    const cutoff = new Date(parsed).getTime();
    const targets = runs.filter((r) => {
      // Runs without a `startedAt` predate the column being recorded;
      // bulk-deleting those when an operator asks for `--before <X>`
      // is the conservative call (they're at least as old as X).
      if (!r.startedAt) return true;
      return r.startedAt.getTime() <= cutoff;
    });
    let deleted = 0;
    for (const target of targets) {
      if (await options.historyStore.deleteRun(target.id)) {
        deleted += 1;
      }
    }
    return { before, deleted, scanned: runs.length };
  });

  // 404 (not 200 + zero) when no counter is wired so callers can
  // tell "no detections yet" apart from "telemetry off".
  server.get("/api/admin/security/injection-counts", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.injectionDetectionCounter) {
      return reply.status(404).send({
        code: "INJECTION_COUNTER_DISABLED",
        message: "Injection detection counter is not wired into this server"
      });
    }
    return options.injectionDetectionCounter.snapshot();
  });
}
