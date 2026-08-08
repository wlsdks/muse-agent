import type { MessagingRouteResolution } from "@muse/autoconfigure";

const ROUTE_STATUSES = new Set<MessagingRouteResolution["status"]>([
  "resolved",
  "unconfigured",
  "ambiguous",
  "blocked-local-only"
]);
const ROUTE_SOURCES = new Set<NonNullable<MessagingRouteResolution["source"]>>([
  "explicit-config",
  "paired-owner"
]);
const ROUTE_REASONS = new Set<NonNullable<MessagingRouteResolution["reason"]>>([
  "explicit-route-incomplete",
  "explicit-provider-not-registered",
  "remote-route-blocked-by-local-only",
  "paired-route-inspection-unavailable",
  "malformed-paired-route",
  "no-single-paired-route",
  "multiple-paired-routes"
]);

export function unavailableMessagingRouteReceipt(localOnly = false): MessagingRouteResolution {
  return {
    destination: null,
    localOnly,
    providerId: null,
    reason: "paired-route-inspection-unavailable",
    source: null,
    status: "unconfigured"
  };
}

export function sanitizeMessagingRouteReceipt(value: unknown, fallbackLocalOnly = false): MessagingRouteResolution {
  if (typeof value !== "object" || value === null) {
    return unavailableMessagingRouteReceipt(fallbackLocalOnly);
  }

  try {
    const candidate = value as Record<string, unknown>;
    const status = candidate.status;
    const source = candidate.source;
    const providerId = candidate.providerId;
    const destination = candidate.destination;
    const localOnly = candidate.localOnly;
    const reason = candidate.reason;
    if (
      typeof status !== "string" || !ROUTE_STATUSES.has(status as MessagingRouteResolution["status"])
      || (source !== null && (typeof source !== "string" || !ROUTE_SOURCES.has(source as NonNullable<MessagingRouteResolution["source"]>)))
      || (providerId !== null && typeof providerId !== "string")
      || (destination !== null && typeof destination !== "string")
      || typeof localOnly !== "boolean"
      || (reason !== null && (typeof reason !== "string" || !ROUTE_REASONS.has(reason as NonNullable<MessagingRouteResolution["reason"]>)))
    ) {
      return unavailableMessagingRouteReceipt(fallbackLocalOnly);
    }
    return {
      destination: destination === null ? null : (destination as string).trim(),
      localOnly,
      providerId: providerId === null ? null : (providerId as string).trim(),
      reason: reason as MessagingRouteResolution["reason"],
      source: source as MessagingRouteResolution["source"],
      status: status as MessagingRouteResolution["status"]
    };
  } catch {
    return unavailableMessagingRouteReceipt(fallbackLocalOnly);
  }
}
