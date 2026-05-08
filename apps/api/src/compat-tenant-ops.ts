/**
 * Reactor-compat tenant operations + the static reactor prompt-section keys
 * list, extracted from reactor-compat-routes.ts.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponse,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function reactorPromptSectionKeys(): string[] {
  return [
    "accuracy",
    "cross-tool",
    "critical",
    "domain:aggregate",
    "domain:marketing",
    "domain:onboarding",
    "domain:policy",
    "domain:summon",
    "domain:workspace",
    "format-slack",
    "identity",
    "proactive",
    "rules",
    "safety",
    "tools",
    "workflow:ask",
    "workflow:search"
  ];
}

export async function updateTenantStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  status: "active" | "suspended"
) {
  if (!options.authorizeAdmin(request, reply)) {
    return reply;
  }

  const { id } = request.params as { readonly id: string };
  const tenants = await (options.admin?.operations?.listTenants() ?? []);
  const tenant = tenants.find((item) => item.id === id);

  if (!tenant) {
    return reply.status(404).send(errorResponse(`Tenant not found: ${id}`));
  }

  return options.admin?.operations?.upsertTenant({
    id,
    monthlyBudgetUsd: tenant.monthlyBudgetUsd,
    name: tenant.name,
    status
  });
}

export async function tenantSummary(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  if (!options.authorizeAnyAdmin(request, reply)) {
    return reply;
  }

  const [tenants, alerts, slos, cost] = await Promise.all([
    options.admin?.operations?.listTenants() ?? [],
    options.admin?.operations?.listAlerts() ?? [],
    options.admin?.operations?.listSlos() ?? [],
    options.admin?.operations?.costSummary() ?? { byModel: {}, byTenant: {}, totalCostUsd: "0.00000000" }
  ]);

  return { alerts, cost, slos, tenants };
}
