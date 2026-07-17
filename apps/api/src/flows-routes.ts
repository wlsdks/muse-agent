/**
 * `GET /api/flows` — the "흐름" (Flows) tab's read-only node-canvas feed.
 * Every flow is a real scheduler job projected through `flow-projection.ts`
 * (pure, fabrication 0) — nothing here is editable or model-generated.
 * Same store-access pattern + fail-open posture as `automation-routes.ts`:
 * a broken/unconfigured scheduler returns an empty list, never a 500.
 */

import type { FastifyInstance } from "fastify";

import { projectFlows, type FlowProjection } from "./flow-projection.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";
import type { ServerOptions } from "./server.js";

export interface FlowsRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly scheduler?: SchedulerRouteScheduler;
}

export interface FlowsResponse {
  readonly flows: readonly FlowProjection[];
}

export function registerFlowsRoutes(server: FastifyInstance, gate: FlowsRoutesGate): void {
  server.get("/api/flows", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    const response: FlowsResponse = { flows: await resolveFlows(gate.scheduler) };
    return response;
  });
}

async function resolveFlows(scheduler: SchedulerRouteScheduler | undefined): Promise<readonly FlowProjection[]> {
  if (!scheduler) {
    return [];
  }

  try {
    const jobs = await (scheduler.service?.list() ?? scheduler.store.list());
    return projectFlows(jobs);
  } catch {
    return [];
  }
}
