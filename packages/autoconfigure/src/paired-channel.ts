/**
 * Day-rhythm's channel auto-routing: resolve the SINGLE paired messaging
 * channel so a briefing/digest tick can send to it instead of the "log"
 * sink default when the user turned day-rhythm on but never separately
 * configured `--provider`/`--destination`. Shared by apps/cli (daemon
 * ticks + doctor) and apps/api (day-rhythm routes) — a package, not
 * either app, because apps/api cannot depend on apps/cli.
 */

import { promises as fs, readFileSync } from "node:fs";

import { isLocalOnlyEnabled } from "@muse/model";
import { isRecord, parseJson } from "@muse/shared";

/**
 * Reads one provider's paired-owner chat id from `~/.muse/channel-owners.json`
 * (`MUSE_CHANNEL_OWNERS_FILE`) — the same file `apps/api/src/
 * channel-owner-store.ts`'s `readChannelOwner` reads, reimplemented here
 * (not imported) because apps/cli cannot depend on apps/api, the identical
 * constraint `model-registry.ts`'s `readMuseCliConfigFile` documents for the
 * CLI config file. Absent/malformed file ⇒ no owner (fail-close, never
 * throws).
 */
export async function readChannelOwner(file: string, providerId: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  return parseChannelOwner(text, providerId);
}

function parseChannelOwner(text: string, providerId: string): string | undefined {
  const parsed = parseJson(text);
  if (!isRecord(parsed) || !isRecord(parsed.owners)) {
    return undefined;
  }
  const owner = parsed.owners[providerId];
  return typeof owner === "string" && owner.trim().length > 0 ? owner : undefined;
}

/** The channel-pairing surface's connectable provider ids (mirrors apps/api's `CONNECTABLE`). */
export const PAIRABLE_MESSAGING_PROVIDER_IDS = ["telegram", "discord", "slack", "line", "matrix"] as const;

export interface MessagingRouteRegistry {
  readonly has: (providerId: string) => boolean;
  readonly describe?: () => readonly { readonly id: string; readonly local?: boolean }[];
}

export interface PairedChannel {
  readonly providerId: string;
  readonly destination: string;
}

export type PairedChannelInspection =
  | { readonly status: "none"; readonly candidates: readonly [] }
  | { readonly status: "resolved"; readonly candidates: readonly [PairedChannel]; readonly channel: PairedChannel }
  | { readonly status: "ambiguous"; readonly candidates: readonly PairedChannel[] }
  | { readonly status: "malformed"; readonly candidates: readonly [] };

export type MessagingRouteResolution = {
  readonly status: "resolved" | "unconfigured" | "ambiguous" | "blocked-local-only";
  readonly source: "explicit-config" | "paired-owner" | null;
  readonly providerId: string | null;
  readonly destination: string | null;
  readonly localOnly: boolean;
  readonly reason:
    | "explicit-route-incomplete"
    | "explicit-provider-not-registered"
    | "remote-route-blocked-by-local-only"
    | "paired-route-inspection-unavailable"
    | "malformed-paired-route"
    | "no-single-paired-route"
    | "multiple-paired-routes"
    | null;
};

export interface ResolveProactiveMessagingRouteOptions {
  readonly registry?: MessagingRouteRegistry;
  readonly ownersFile?: string;
  readonly localOnly?: boolean;
  /**
   * API-only compatibility: when neither canonical proactive route key is
   * present, use the legacy situational-briefing pair as the effective
   * explicit route. A partial canonical pair still wins and fails closed.
   */
  readonly allowBriefingFallback?: boolean;
}

/**
 * Resolves the shared proactive/digest route used by the Gateway preview.
 * Explicit provider and destination values are authoritative: a partial pair
 * never falls through to a paired owner. Without explicit values, non-local
 * mode requires one live-registered paired owner. Local-only mode reads the
 * owners file without probing the remote registry, because pairable channels
 * are remote.
 */
export function resolveProactiveMessagingRoute(
  env: Readonly<Record<string, string | undefined>>,
  options: ResolveProactiveMessagingRouteOptions = {}
): MessagingRouteResolution {
  const localOnly = options.localOnly ?? isLocalOnlyEnabled(env);
  const proactiveProvider = env.MUSE_PROACTIVE_PROVIDER?.trim() || "";
  const proactiveDestination = env.MUSE_PROACTIVE_DESTINATION?.trim() || "";
  const useBriefingFallback = options.allowBriefingFallback
    && proactiveProvider.length === 0
    && proactiveDestination.length === 0;
  const providerId = (useBriefingFallback ? env.MUSE_BRIEFING_PROVIDER : proactiveProvider)?.trim() || "";
  const destination = (useBriefingFallback ? env.MUSE_BRIEFING_DESTINATION : proactiveDestination)?.trim() || "";
  const hasExplicitProvider = providerId.length > 0;
  const hasExplicitDestination = destination.length > 0;

  if (hasExplicitProvider || hasExplicitDestination) {
    if (!hasExplicitProvider || !hasExplicitDestination) {
      return {
        destination: hasExplicitDestination ? destination : null,
        localOnly,
        providerId: hasExplicitProvider ? providerId : null,
        reason: "explicit-route-incomplete",
        source: "explicit-config",
        status: "unconfigured"
      };
    }

    if (localOnly && isRemoteMessagingProvider(providerId)) {
      return {
        destination,
        localOnly,
        providerId,
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only"
      };
    }

    if (!options.registry?.has(providerId)) {
      return {
        destination,
        localOnly,
        providerId,
        reason: "explicit-provider-not-registered",
        source: "explicit-config",
        status: "unconfigured"
      };
    }

    if (localOnly && !isLocalMessagingProvider(options.registry, providerId)) {
      return {
        destination,
        localOnly,
        providerId,
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only"
      };
    }

    return {
      destination,
      localOnly,
      providerId,
      reason: null,
      source: "explicit-config",
      status: "resolved"
    };
  }

  if (localOnly) {
    const ownersFile = options.ownersFile;
    if (!ownersFile) {
      return unavailableMessagingRoute(localOnly);
    }

    const inspection = inspectPairedChannelsSync(ownersFile);
    if (inspection.status === "ambiguous") {
      return {
        destination: null,
        localOnly,
        providerId: null,
        reason: "multiple-paired-routes",
        source: null,
        status: "ambiguous"
      };
    }
    if (inspection.status === "none") {
      return {
        destination: null,
        localOnly,
        providerId: null,
        reason: "no-single-paired-route",
        source: null,
        status: "unconfigured"
      };
    }
    if (inspection.status === "malformed") {
      return {
        destination: null,
        localOnly,
        providerId: null,
        reason: "malformed-paired-route",
        source: null,
        status: "unconfigured"
      };
    }

    return {
      destination: inspection.channel.destination,
      localOnly,
      providerId: inspection.channel.providerId,
      reason: "remote-route-blocked-by-local-only",
      source: "paired-owner",
      status: "blocked-local-only"
    };
  }

  if (!options.registry || !options.ownersFile) {
    return unavailableMessagingRoute(localOnly);
  }

  const inspection = inspectPairedChannelsSync(options.ownersFile, options.registry);
  if (inspection.status === "ambiguous") {
    return {
      destination: null,
      localOnly,
      providerId: null,
      reason: "multiple-paired-routes",
      source: null,
      status: "ambiguous"
    };
  }
  if (inspection.status === "none") {
    return {
      destination: null,
      localOnly,
      providerId: null,
      reason: "no-single-paired-route",
      source: null,
      status: "unconfigured"
    };
  }
  if (inspection.status === "malformed") {
    return {
      destination: null,
      localOnly,
      providerId: null,
      reason: "malformed-paired-route",
      source: null,
      status: "unconfigured"
    };
  }

  return {
    destination: inspection.channel.destination,
    localOnly,
    providerId: inspection.channel.providerId,
    reason: null,
    source: "paired-owner",
    status: "resolved"
  };
}

function isLocalMessagingProvider(registry: MessagingRouteRegistry, providerId: string): boolean {
  return registry.describe?.().some((provider) => provider.id === providerId && provider.local === true) ?? false;
}

function isRemoteMessagingProvider(providerId: string): boolean {
  return (PAIRABLE_MESSAGING_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function unavailableMessagingRoute(localOnly: boolean): MessagingRouteResolution {
  return {
    destination: null,
    localOnly,
    providerId: null,
    reason: "paired-route-inspection-unavailable",
    source: null,
    status: "unconfigured"
  };
}

function inspectPairedChannelsSync(
  ownersFile: string,
  registry?: Pick<MessagingRouteRegistry, "has">
): PairedChannelInspection {
  const owners = readPairedOwnersSync(ownersFile);
  if (owners.status === "malformed") return { candidates: [], status: "malformed" };
  if (owners.status === "unavailable") return { candidates: [], status: "none" };
  const candidates: PairedChannel[] = [];
  for (const providerId of PAIRABLE_MESSAGING_PROVIDER_IDS) {
    if (registry && !registry.has(providerId)) {
      continue;
    }
    if (!Object.hasOwn(owners.owners, providerId)) continue;
    const owner = owners.owners[providerId];
    if (typeof owner !== "string" || owner.trim().length === 0) return { candidates: [], status: "malformed" };
    candidates.push({ destination: owner, providerId });
  }
  if (candidates.length === 0) {
    return { candidates: [], status: "none" };
  }
  if (candidates.length > 1) {
    return { candidates, status: "ambiguous" };
  }
  const channel = candidates[0]!;
  return { candidates: [channel], channel, status: "resolved" };
}

/**
 * Inspects all live-registered paired channels without choosing a target.
 * The structured result lets read-only surfaces explain why auto-routing is
 * unavailable while the existing resolver keeps its fail-closed API.
 */
export async function inspectPairedChannels(
  ownersFile: string,
  registry: { readonly has: (providerId: string) => boolean }
): Promise<PairedChannelInspection> {
  const owners = await readPairedOwners(ownersFile);
  if (owners.status === "malformed") return { candidates: [], status: "malformed" };
  if (owners.status === "unavailable") return { candidates: [], status: "none" };
  const candidates: PairedChannel[] = [];
  for (const providerId of PAIRABLE_MESSAGING_PROVIDER_IDS) {
    if (!registry.has(providerId)) {
      continue;
    }
    if (!Object.hasOwn(owners.owners, providerId)) continue;
    const owner = owners.owners[providerId];
    if (typeof owner !== "string" || owner.trim().length === 0) return { candidates: [], status: "malformed" };
    candidates.push({ destination: owner, providerId });
  }
  if (candidates.length === 0) {
    return { candidates: [], status: "none" };
  }
  if (candidates.length > 1) {
    return { candidates, status: "ambiguous" };
  }
  const channel = candidates[0]!;
  return { candidates: [channel], channel, status: "resolved" };
}

/**
 * Resolves the day-rhythm auto-route target: the ONE paired AND
 * live-registered messaging channel. Zero paired channels, or more than
 * one, both return `undefined` — auto-routing never guesses which channel
 * the user means (fail-close, mirrors outbound-safety's "recipient
 * resolved, never guessed" rule).
 */
export async function resolveSinglePairedChannel(
  ownersFile: string,
  registry: { readonly has: (providerId: string) => boolean }
): Promise<PairedChannel | undefined> {
  const inspection = await inspectPairedChannels(ownersFile, registry);
  return inspection.status === "resolved" ? inspection.channel : undefined;
}

type PairedOwnerRead =
  | { readonly status: "valid"; readonly owners: Record<string, unknown> }
  | { readonly status: "malformed" }
  | { readonly status: "unavailable" };

function readPairedOwnersSync(file: string): PairedOwnerRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { status: "unavailable" };
  }
  return parsePairedOwners(text);
}

async function readPairedOwners(file: string): Promise<PairedOwnerRead> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { status: "unavailable" };
  }
  return parsePairedOwners(text);
}

function parsePairedOwners(text: string): PairedOwnerRead {
  const parsed = parseJson(text);
  if (!isRecord(parsed) || !isRecord(parsed.owners)) return { status: "malformed" };
  return { owners: parsed.owners, status: "valid" };
}
