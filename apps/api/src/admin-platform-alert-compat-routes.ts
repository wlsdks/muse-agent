/**
 * Reactor-compat admin platform-alert routes extracted from
 * reactor-compat-routes.ts.
 *
 * Wires:
 *   - GET /api/admin/platform/alerts (open only)
 *   - POST /api/admin/platform/alerts/evaluate
 *   - POST /api/admin/platform/alerts/:id/resolve
 */

import type { FastifyInstance } from "fastify";
import {
  recordAdminAudit,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerAdminPlatformAlertCompatRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/platform/alerts", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const alerts = await (options.admin?.operations?.listAlerts() ?? []);
    return alerts.filter((alert) => alert.status === "open");
  });
  server.post("/api/admin/platform/alerts/evaluate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    await recordAdminAudit(request, options, {
      action: "ALERT_EVALUATE",
      category: "platform_alert",
      resourceType: "alert_rule_set"
    });

    return { status: "evaluation complete" };
  });
  server.post("/api/admin/platform/alerts/:id/resolve", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    await options.admin?.operations?.resolveAlert(id);
    await recordAdminAudit(request, options, {
      action: "ALERT_RESOLVE",
      category: "platform_alert",
      resourceId: id,
      resourceType: "alert"
    });
    return reply.status(200).send();
  });
}
