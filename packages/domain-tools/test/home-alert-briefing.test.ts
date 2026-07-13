import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { resolveHomeAlertLine, type HomeAlertCheck } from "../src/smart-home.js";
import { runDueSituationalBriefing } from "../src/situational-briefing-loop.js";
import { writeObjectives } from "@muse/stores";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

// Contract-faithful Home Assistant: GET /api/states/<id> → HA body shape.
function haStates(map: Record<string, string>) {
  return (async (url: string) => {
    const entityId = url.split("/api/states/")[1] ?? "";
    const state = map[entityId];
    if (state === undefined) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(JSON.stringify({ attributes: {}, entity_id: entityId, state }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const CHECKS: HomeAlertCheck[] = [
  { alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" },
  { alertStates: ["open"], entityId: "cover.garage", label: "Garage" }
];

describe("resolveHomeAlertLine — surfaces only noteworthy home states", () => {
  it("flags entities in an alert state, joined; quiet ones omitted", async () => {
    const line = await resolveHomeAlertLine(
      { baseUrl: "http://ha.local", fetchImpl: haStates({ "cover.garage": "open", "lock.front_door": "unlocked" }), retryOptions: noWait, token: "t" },
      CHECKS
    );
    expect(line).toBe("Front door is unlocked; Garage is open");
  });

  it("returns undefined when everything is in a safe state (no narration of normal)", async () => {
    const line = await resolveHomeAlertLine(
      { baseUrl: "http://ha.local", fetchImpl: haStates({ "cover.garage": "closed", "lock.front_door": "locked" }), retryOptions: noWait, token: "t" },
      CHECKS
    );
    expect(line).toBeUndefined();
  });

  it("a per-entity read failure is skipped, the rest still surface", async () => {
    const line = await resolveHomeAlertLine(
      { baseUrl: "http://ha.local", fetchImpl: haStates({ "lock.front_door": "unlocked" }), retryOptions: noWait, token: "t" }, // garage 404s
      CHECKS
    );
    expect(line).toBe("Front door is unlocked");
  });

  it("does not read a token or fetch a remote Home Assistant alert under local-only", async () => {
    let tokenReads = 0;
    let fetches = 0;
    const connection = {
      baseUrl: "http://ha.local:8123",
      fetchImpl: (async () => {
        fetches += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch,
      localOnly: true,
      retryOptions: noWait
    } as Record<string, unknown>;
    Object.defineProperty(connection, "token", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("remote alert token must not be read");
      }
    });

    await expect(resolveHomeAlertLine(connection as never, CHECKS)).resolves.toBeUndefined();
    expect(tokenReads).toBe(0);
    expect(fetches).toBe(0);
  });
});

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

describe("runDueSituationalBriefing — the home-alert line rides a briefing end-to-end", () => {
  it("delivers a briefing whose Home line flags the unlocked door (alongside an imminent item)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-home-brief-"));
    const objectivesFile = join(dir, "objectives.json");
    const sidecarFile = join(dir, "sidecar.json");
    await writeObjectives(objectivesFile, []);
    const sent: OutboundMessage[] = [];

    const summary = await runDueSituationalBriefing({
      destination: "555",
      homeAlert: () => resolveHomeAlertLine(
        { baseUrl: "http://ha.local", fetchImpl: haStates({ "cover.garage": "closed", "lock.front_door": "unlocked" }), retryOptions: noWait, token: "t" },
        CHECKS
      ),
      imminent: [{ startsAt: new Date(Date.now() + 1_800_000), title: "Standup" }],
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => new Date(),
      objectivesFile,
      providerId: "telegram",
      sidecarFile
    });

    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).toContain("Home: Front door is unlocked");
    expect(sent[0]!.text).toContain("Standup");
  });
});
