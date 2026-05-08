/**
 * Reactor-compat RBAC role + retention policy helpers extracted from
 * reactor-compat-routes.ts.
 *
 * - role helpers normalize the two-role taxonomy (user / admin) into
 *   the response shape used by /api/admin/rbac/roles +
 *   /api/admin/platform/users/:id/role.
 * - parseRetentionPolicy validates the four day-count knobs the
 *   /api/admin/retention surface accepts.
 */

import type { UserRole } from "@muse/auth";
import type { JsonObject } from "@muse/shared";
import {
  invalid,
  readNumber,
  toBody,
  type ParseResult
} from "./reactor-compat-routes.js";

export function userRoleResponse(role: UserRole): string {
  return role.toUpperCase();
}

export function parseUserRole(value: unknown): UserRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase() as UserRole;
  return normalized === "user" || normalized === "admin" ? normalized : undefined;
}

export function roleDefinitions(): readonly JsonObject[] {
  const roles: readonly UserRole[] = ["user", "admin"];
  return roles.map((role) => ({
    permissions: [...permissionsForRole(role)],
    role: userRoleResponse(role),
    scope: role === "admin" ? "FULL" : null
  }));
}

function permissionsForRole(role: UserRole): readonly string[] {
  if (role === "admin") {
    return [
      "persona:read", "persona:write",
      "prompt:read", "prompt:write",
      "session:read", "session:export",
      "feedback:read",
      "guard:read", "guard:write",
      "mcp:read", "mcp:write",
      "scheduler:read", "scheduler:write",
      "audit:read", "audit:export",
      "user:read", "user:write",
      "settings:read", "settings:write",
      "agent-spec:read", "agent-spec:write"
    ];
  }

  return ["chat:use", "persona:select"];
}

export function parseRetentionPolicy(value: unknown): ParseResult<JsonObject> {
  const body = toBody(value);
  const parsed: Record<string, number> = {};

  for (const key of [
    "sessionRetentionDays",
    "conversationRetentionDays",
    "auditRetentionDays",
    "metricRetentionDays"
  ]) {
    if (body[key] === undefined || body[key] === null) {
      continue;
    }

    const parsedValue = readNumber(body[key], Number.NaN);

    if (!Number.isInteger(parsedValue) || parsedValue < 1) {
      return invalid("INVALID_RETENTION_POLICY", `${key} must be >= 1`);
    }

    parsed[key] = parsedValue;
  }

  return { ok: true, value: parsed };
}
