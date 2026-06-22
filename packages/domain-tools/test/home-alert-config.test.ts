import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { parseHomeAlertChecks, resolveHomeAlertLine } from "../src/smart-home.js";
import { runDueSituationalBriefing } from "../src/situational-briefing-loop.js";
import { writeObjectives } from "@muse/stores";

describe("parseHomeAlertChecks — parse the briefing home-alert config", () => {
  it("parses valid checks and drops invalid / non-array / malformed entries", () => {
    const checks = parseHomeAlertChecks(JSON.stringify([
      { alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" },
      { alertStates: ["open"], entityId: "", label: "bad-entity" },
      { alertStates: [], entityId: "sensor.x", label: "no-states" },
      { entityId: "sensor.y", label: "no-states-field" },
      { alertStates: ["open"], label: "no-entity" }
    ]));
    expect(checks).toEqual([{ alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" }]);
    expect(parseHomeAlertChecks("{not json")).toEqual([]);
    expect(parseHomeAlertChecks(JSON.stringify({ not: "array" }))).toEqual([]);
  });

  it("filters non-string alertStates entries, dropping a check left with none", () => {
    const checks = parseHomeAlertChecks(JSON.stringify([
      { alertStates: ["open", 5, ""], entityId: "cover.garage", label: "Garage" },
      { alertStates: [42, null], entityId: "x.y", label: "all-bad" }
    ]));
    expect(checks).toEqual([{ alertStates: ["open"], entityId: "cover.garage", label: "Garage" }]);
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

function haStates(map: Record<string, string>) {
  return (async (url: string) => {
    const entityId = url.split("/api/states/")[1] ?? "";
    const state = map[entityId];
    return state === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(JSON.stringify({ attributes: {}, entity_id: entityId, state }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("briefing daemon wiring — parsed config → bound resolver → delivered brief", () => {
  it("the exact daemon composition (parseHomeAlertChecks → resolveHomeAlertLine) delivers a Home line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-home-cfg-"));
    const objectivesFile = join(dir, "objectives.json");
    await writeObjectives(objectivesFile, []);

    const checks = parseHomeAlertChecks(JSON.stringify([
      { alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" }
    ]));
    const fetchImpl = haStates({ "lock.front_door": "unlocked" });
    const sent: OutboundMessage[] = [];

    const summary = await runDueSituationalBriefing({
      destination: "555",
      homeAlert: () => resolveHomeAlertLine({ baseUrl: "http://ha.local", fetchImpl, retryOptions: { baseDelayMs: 0, sleep: async () => {} }, token: "t" }, checks),
      imminent: [{ startsAt: new Date(Date.now() + 1_800_000), title: "Standup" }],
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      objectivesFile,
      providerId: "telegram",
      sidecarFile: join(dir, "sidecar.json")
    });

    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).toContain("Home: Front door is unlocked");
  });
});
