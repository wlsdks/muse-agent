/**
 * Reactor-compat RBAC role + retention policy helpers extracted from
 * reactor-compat-routes.ts.
 *
 * - role helpers normalize the four-role taxonomy
 *   (user / admin / admin_manager / admin_developer) into the response
 *   shape used by /api/admin/rbac/roles + /api/admin/platform/users/:id/role
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

function userRoleScope(role: UserRole): string | null {
  if (role === "admin") {
    return "FULL";
  }

  if (role === "admin_manager") {
    return "MANAGER";
  }

  if (role === "admin_developer") {
    return "DEVELOPER";
  }

  return null;
}

export function parseUserRole(value: unknown): UserRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase() as UserRole;
  return normalized === "user"
    || normalized === "admin"
    || normalized === "admin_manager"
    || normalized === "admin_developer"
    ? normalized
    : undefined;
}

export function roleDefinitions(): readonly JsonObject[] {
  const roles: readonly UserRole[] = ["user", "admin", "admin_manager", "admin_developer"];
  return roles.map((role) => ({
    permissions: [...permissionsForRole(role)],
    role: userRoleResponse(role),
    scope: userRoleScope(role)
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

  if (role === "admin_developer") {
    return [
      "persona:read", "persona:write",
      "prompt:read", "prompt:write",
      "session:read",
      "feedback:read",
      "guard:read", "guard:write",
      "mcp:read", "mcp:write",
      "scheduler:read", "scheduler:write",
      "audit:read",
      "agent-spec:read", "agent-spec:write"
    ];
  }

  if (role === "admin_manager") {
    return ["session:read", "session:export", "feedback:read", "audit:read", "persona:read"];
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
