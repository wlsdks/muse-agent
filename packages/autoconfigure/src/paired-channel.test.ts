import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectPairedChannels,
  readChannelOwner,
  resolveProactiveMessagingRoute,
  resolveSinglePairedChannel,
  type MessagingRouteRegistry
} from "./paired-channel.js";

function tmpOwnersFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-paired-channel-"));
  return join(dir, "channel-owners.json");
}

function registryOf(...ids: readonly string[]): { readonly has: (providerId: string) => boolean } {
  const set = new Set(ids);
  return { has: (id) => set.has(id) };
}

function routeRegistryOf(...providers: readonly { readonly id: string; readonly local?: boolean }[]): MessagingRouteRegistry {
  const ids = new Set(providers.map((provider) => provider.id));
  return {
    describe: () => providers,
    has: (id) => ids.has(id)
  };
}

describe("readChannelOwner", () => {
  it("an absent file has no owner", async () => {
    expect(await readChannelOwner(tmpOwnersFile(), "telegram")).toBeUndefined();
  });

  it("a malformed file has no owner (fail-close, never throws)", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, "not json");
    expect(await readChannelOwner(file, "telegram")).toBeUndefined();
  });

  it("reads a paired owner by provider id", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    expect(await readChannelOwner(file, "telegram")).toBe("555");
    expect(await readChannelOwner(file, "discord")).toBeUndefined();
  });
});

describe("resolveSinglePairedChannel", () => {
  it("zero paired channels ⇒ undefined (fail-close)", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: {}, version: 1 }));
    expect(await resolveSinglePairedChannel(file, registryOf("telegram"))).toBeUndefined();
  });

  it("exactly one paired AND registered channel ⇒ that channel", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    expect(await resolveSinglePairedChannel(file, registryOf("telegram"))).toEqual({
      destination: "555",
      providerId: "telegram"
    });
  });

  it("paired but NOT registered ⇒ undefined (a stale pairing with no live provider is not a target)", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    expect(await resolveSinglePairedChannel(file, registryOf("discord"))).toBeUndefined();
  });

  it("more than one paired + registered channel ⇒ undefined (never guesses which one)", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { discord: "999", telegram: "555" }, version: 1 }));
    expect(await resolveSinglePairedChannel(file, registryOf("telegram", "discord"))).toBeUndefined();
  });
});

describe("inspectPairedChannels", () => {
  it("distinguishes no live paired route from ambiguity", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { discord: "999", telegram: "555" }, version: 1 }));

    await expect(inspectPairedChannels(file, registryOf("slack"))).resolves.toEqual({ candidates: [], status: "none" });
    await expect(inspectPairedChannels(file, registryOf("telegram", "discord"))).resolves.toEqual({
      candidates: [
        { destination: "555", providerId: "telegram" },
        { destination: "999", providerId: "discord" }
      ],
      status: "ambiguous"
    });
  });

  it("returns the exact single registered owner without guessing", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    await expect(inspectPairedChannels(file, registryOf("telegram"))).resolves.toEqual({
      candidates: [{ destination: "555", providerId: "telegram" }],
      channel: { destination: "555", providerId: "telegram" },
      status: "resolved"
    });
  });
});

describe("resolveProactiveMessagingRoute", () => {
  it("can preserve the API's legacy briefing pair without overriding a canonical or partial proactive pair", () => {
    expect(resolveProactiveMessagingRoute(
      { MUSE_BRIEFING_DESTINATION: "briefing-555", MUSE_BRIEFING_PROVIDER: "telegram" },
      { allowBriefingFallback: true, registry: routeRegistryOf({ id: "telegram" }) }
    )).toMatchObject({
      destination: "briefing-555",
      providerId: "telegram",
      source: "explicit-config",
      status: "resolved"
    });

    expect(resolveProactiveMessagingRoute(
      {
        MUSE_BRIEFING_DESTINATION: "briefing-555",
        MUSE_BRIEFING_PROVIDER: "telegram",
        MUSE_PROACTIVE_DESTINATION: "proactive-999",
        MUSE_PROACTIVE_PROVIDER: "discord"
      },
      { allowBriefingFallback: true, registry: routeRegistryOf({ id: "discord" }, { id: "telegram" }) }
    )).toMatchObject({ destination: "proactive-999", providerId: "discord", status: "resolved" });

    expect(resolveProactiveMessagingRoute(
      { MUSE_BRIEFING_DESTINATION: "briefing-555", MUSE_BRIEFING_PROVIDER: "telegram", MUSE_PROACTIVE_PROVIDER: "discord" },
      { allowBriefingFallback: true, registry: routeRegistryOf({ id: "discord" }, { id: "telegram" }) }
    )).toMatchObject({ reason: "explicit-route-incomplete", status: "unconfigured" });
  });

  it("resolves a complete explicit route only when its provider is live-registered", () => {
    expect(resolveProactiveMessagingRoute(
      { MUSE_PROACTIVE_DESTINATION: "555", MUSE_PROACTIVE_PROVIDER: "telegram" },
      { registry: routeRegistryOf({ id: "telegram" }) }
    )).toEqual({
      destination: "555",
      localOnly: false,
      providerId: "telegram",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    });

    expect(resolveProactiveMessagingRoute(
      { MUSE_PROACTIVE_DESTINATION: "555", MUSE_PROACTIVE_PROVIDER: "telegram" },
      { registry: routeRegistryOf() }
    ).status).toBe("unconfigured");
  });

  it("keeps an incomplete explicit route fail-closed instead of using a paired owner", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "paired-555" }, version: 1 }));
    expect(resolveProactiveMessagingRoute(
      { MUSE_PROACTIVE_PROVIDER: "telegram" },
      { ownersFile: file, registry: routeRegistryOf({ id: "telegram" }) }
    )).toEqual({
      destination: null,
      localOnly: false,
      providerId: "telegram",
      reason: "explicit-route-incomplete",
      source: "explicit-config",
      status: "unconfigured"
    });
  });

  it("resolves one live paired owner, but not zero or multiple owners", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    expect(resolveProactiveMessagingRoute(
      {},
      { ownersFile: file, registry: routeRegistryOf({ id: "telegram" }) }
    )).toMatchObject({ destination: "555", providerId: "telegram", source: "paired-owner", status: "resolved" });

    await writeFile(file, JSON.stringify({ owners: { discord: "999", telegram: "555" }, version: 1 }));
    expect(resolveProactiveMessagingRoute(
      {},
      { ownersFile: file, registry: routeRegistryOf({ id: "telegram" }, { id: "discord" }) }
    )).toMatchObject({ reason: "multiple-paired-routes", status: "ambiguous" });

    await writeFile(file, JSON.stringify({ owners: {}, version: 1 }));
    expect(resolveProactiveMessagingRoute(
      {},
      { ownersFile: file, registry: routeRegistryOf({ id: "telegram" }) }
    )).toMatchObject({ reason: "no-single-paired-route", status: "unconfigured" });
  });

  it("blocks local-only remote routes before probing the registry", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    const probes: string[] = [];
    const registry: MessagingRouteRegistry = {
      describe: () => [],
      has: (providerId) => {
        probes.push(providerId);
        return true;
      }
    };

    expect(resolveProactiveMessagingRoute(
      { MUSE_LOCAL_ONLY: "true" },
      { ownersFile: file, registry }
    )).toMatchObject({
      destination: "555",
      providerId: "telegram",
      reason: "remote-route-blocked-by-local-only",
      source: "paired-owner",
      status: "blocked-local-only"
    });
    expect(probes).toEqual([]);

    expect(resolveProactiveMessagingRoute(
      { MUSE_LOCAL_ONLY: "true", MUSE_PROACTIVE_DESTINATION: "555", MUSE_PROACTIVE_PROVIDER: "telegram" },
      { registry }
    )).toMatchObject({
      reason: "remote-route-blocked-by-local-only",
      status: "blocked-local-only"
    });
    expect(probes).toEqual([]);
  });

  it("keeps local-only without an owners file unconfigured and does not probe the registry", () => {
    const probes: string[] = [];
    const registry: MessagingRouteRegistry = {
      has: (providerId) => {
        probes.push(providerId);
        return true;
      }
    };

    expect(resolveProactiveMessagingRoute(
      { MUSE_LOCAL_ONLY: "true" },
      { registry }
    )).toMatchObject({
      reason: "paired-route-inspection-unavailable",
      status: "unconfigured"
    });
    expect(probes).toEqual([]);
  });

  it("keeps local-only without a pair unconfigured", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: {}, version: 1 }));
    const probes: string[] = [];
    const registry: MessagingRouteRegistry = {
      has: (providerId) => {
        probes.push(providerId);
        return true;
      }
    };

    expect(resolveProactiveMessagingRoute(
      { MUSE_LOCAL_ONLY: "true" },
      { ownersFile: file, registry }
    )).toMatchObject({
      reason: "no-single-paired-route",
      status: "unconfigured"
    });
    expect(probes).toEqual([]);
  });

  it("keeps multiple local-only pairable owners ambiguous without probing the registry", async () => {
    const file = tmpOwnersFile();
    await writeFile(file, JSON.stringify({ owners: { discord: "999", telegram: "555" }, version: 1 }));
    const probes: string[] = [];
    const registry: MessagingRouteRegistry = {
      has: (providerId) => {
        probes.push(providerId);
        return true;
      }
    };

    expect(resolveProactiveMessagingRoute(
      { MUSE_LOCAL_ONLY: "true" },
      { ownersFile: file, registry }
    )).toMatchObject({
      reason: "multiple-paired-routes",
      status: "ambiguous"
    });
    expect(probes).toEqual([]);
  });
});
