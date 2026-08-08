import {
  resolveProactiveMessagingRoute,
  type MessagingRouteResolution
} from "@muse/autoconfigure";
import type { MessagingProviderRegistry } from "@muse/messaging";

export interface ResolveCliMessagingRouteOptions {
  readonly channelOwnersFile: string;
  readonly dayRhythmEnabled: boolean;
  readonly destination: string;
  readonly env: NodeJS.ProcessEnv;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
}

/**
 * Adapts the CLI's already-resolved precedence result to the shared Gateway
 * resolver. The only intentional exception is day-rhythm's default log sink:
 * clearing its explicit route lets the resolver inspect the live paired owner.
 */
export function resolveCliMessagingRoute(
  options: ResolveCliMessagingRouteOptions
): MessagingRouteResolution {
  const usePairedOwner = options.dayRhythmEnabled && options.provider === "log";
  const routeEnv: NodeJS.ProcessEnv = {
    ...options.env,
    MUSE_PROACTIVE_DESTINATION: usePairedOwner ? undefined : options.destination,
    MUSE_PROACTIVE_PROVIDER: usePairedOwner ? undefined : options.provider
  };
  return resolveProactiveMessagingRoute(routeEnv, {
    ownersFile: options.channelOwnersFile,
    registry: options.messagingRegistry
  });
}

export function routeSkipLabel(route: MessagingRouteResolution | undefined): string {
  return route?.status ?? "unavailable";
}
