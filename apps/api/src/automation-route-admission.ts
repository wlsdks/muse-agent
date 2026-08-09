import type { MessagingRouteResolution } from "@muse/autoconfigure";

import {
  sanitizeMessagingRouteReceipt,
  unavailableMessagingRouteReceipt
} from "./messaging-route-receipt.js";

export interface AutomationRouteAdmissionOptions {
  readonly localOnly: boolean;
  readonly resolveRoute: () => unknown;
}

type AdmittedMessagingRoute = MessagingRouteResolution & {
  readonly destination: string;
  readonly providerId: string;
};

export type AutomationRouteAdmission =
  | { readonly admitted: true; readonly route: AdmittedMessagingRoute }
  | { readonly admitted: false; readonly route: MessagingRouteResolution };

export function admitAutomationRoute(
  options: AutomationRouteAdmissionOptions
): AutomationRouteAdmission {
  let resolved: unknown;
  try {
    resolved = options.resolveRoute();
  } catch {
    return { admitted: false, route: unavailableMessagingRouteReceipt(options.localOnly) };
  }

  const route = sanitizeMessagingRouteReceipt(resolved, options.localOnly);
  const providerId = route.providerId?.trim() ?? "";
  const destination = route.destination?.trim() ?? "";
  const normalizedRoute: MessagingRouteResolution = {
    ...route,
    destination: route.destination === null ? null : destination,
    providerId: route.providerId === null ? null : providerId
  };

  if (normalizedRoute.status === "resolved" && providerId.length > 0 && destination.length > 0) {
    return {
      admitted: true,
      route: { ...normalizedRoute, destination, providerId }
    };
  }
  return { admitted: false, route: normalizedRoute };
}
