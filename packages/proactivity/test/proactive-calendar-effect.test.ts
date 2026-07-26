import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CalendarProviderRegistry,
  type CalendarEvent,
  type CalendarProvider
} from "@muse/calendar";
import {
  MessagingProviderRegistry,
  computeOutboundEffectPayloadHash,
  dispatchOutboundEffectOnce,
  prepareOutboundEffect,
  readOutboundEffect,
  readOutboundEffects,
  reconcileOutboundEffect,
  recordOutboundEffectUnknown,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import { readProactiveFired } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  proactiveCalendarOccurrenceEffectId,
  runDueProactiveNotices
} from "../src/proactive-notice-loop.js";

const NOW = new Date("2026-07-27T14:55:00.000Z");
const START = new Date("2026-07-27T15:00:00.000Z");

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-proactive-calendar-effect-"));
  return {
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    historyFile: join(dir, "proactive-history.json"),
    sidecarFile: join(dir, "proactive-fired.json"),
    trustFile: join(dir, "proactive-trust.json")
  };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    allDay: false,
    endsAt: new Date("2026-07-27T15:30:00.000Z"),
    id: "calendar-effect-1",
    providerEventId: "remote-event-17",
    providerId: "caldav",
    startsAt: START,
    title: "Review release",
    ...overrides
  };
}

function calendarRegistry(events: () => readonly CalendarEvent[]): CalendarProviderRegistry {
  const provider: CalendarProvider = {
    createEvent: async () => { throw new Error("not used"); },
    deleteEvent: async () => { throw new Error("not used"); },
    describe: () => ({
      credentials: [],
      description: "test",
      displayName: "Calendar",
      id: "calendar",
      local: true
    }),
    id: "calendar",
    listEvents: async () => events(),
    updateEvent: async () => { throw new Error("not used"); }
  };
  return new CalendarProviderRegistry([provider]);
}

function messaging(
  send: (message: OutboundMessage) => Promise<OutboundReceipt>
): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    send
  };
  return new MessagingProviderRegistry([provider]);
}

function options(
  p: ReturnType<typeof paths>,
  messagingRegistry: MessagingProviderRegistry,
  calendarEvent: CalendarEvent = event()
) {
  return {
    calendarRegistry: calendarRegistry(() => [calendarEvent]),
    destination: "@owner",
    effectFile: p.effectFile,
    heartbeatDir: null,
    messagingRegistry,
    now: () => NOW,
    providerId: "telegram",
    sidecarFile: p.sidecarFile
  } as const;
}

describe("proactive qualified-calendar durable messaging effect", () => {
  it("binds the exact occurrence and persists qualified fired state before post-delivery effects", async () => {
    const p = paths();
    const calendarEvent = event();
    const effectId = proactiveCalendarOccurrenceEffectId(calendarEvent);
    const sent: OutboundMessage[] = [];
    let brokerCalls = 0;
    const summary = await runDueProactiveNotices({
      ...options(p, messaging(async (message) => {
        expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "prepared" });
        expect(await readProactiveFired(p.sidecarFile)).toEqual([]);
        sent.push(message);
        return {
          destination: message.destination,
          messageId: "calendar-accepted-1",
          providerId: "telegram"
        };
      }), calendarEvent),
      agentInitiatedNoticeBroker: {
        publish: () => {
          brokerCalls += 1;
          expect(JSON.parse(readFileSync(p.sidecarFile, "utf8"))).toMatchObject({
            fired: [expect.objectContaining({ providerId: "caldav" })]
          });
        }
      },
      agentInitiatedNoticeUserId: "owner",
      historyFile: p.historyFile,
      trustLedgerFile: p.trustFile
    });

    expect(summary).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(sent).toEqual([
      expect.objectContaining({
        destination: "@owner",
        idempotencyKey: effectId
      })
    ]);
    expect(brokerCalls).toBe(1);
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({
      binding: {
        destination: "@owner",
        effectId,
        payloadHash: computeOutboundEffectPayloadHash({
          destination: "@owner",
          providerId: "telegram",
          text: sent[0]!.text
        }),
        providerId: "telegram"
      },
      state: "accepted"
    });
    expect(await readProactiveFired(p.sidecarFile)).toEqual([
      expect.objectContaining({
        id: "calendar-effect-1",
        kind: "calendar",
        providerEventId: "remote-event-17",
        providerId: "caldav",
        startIso: START.toISOString()
      })
    ]);
    expect(existsSync(p.historyFile)).toBe(true);
    expect(existsSync(p.trustFile)).toBe(true);
  });

  it("repairs accepted state after a sidecar failure with a removed messaging provider and zero egress replay", async () => {
    const p = paths();
    let providerCalls = 0;
    const first = await runDueProactiveNotices(options(p, messaging(async (message) => {
      providerCalls += 1;
      mkdirSync(p.sidecarFile);
      return {
        destination: message.destination,
        messageId: "accepted-before-sidecar-failure",
        providerId: "telegram"
      };
    })));
    expect(first.fired).toBe(0);
    expect(await readOutboundEffects(p.effectFile)).toEqual([
      expect.objectContaining({ state: "accepted" })
    ]);
    rmSync(p.sidecarFile, { force: true, recursive: true });

    let synthesized = 0;
    let investigated = 0;
    let brokerCalls = 0;
    const repaired = await runDueProactiveNotices({
      ...options(p, new MessagingProviderRegistry([])),
      activitySource: { lastActivityMs: () => NOW.getTime() },
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      agentModel: "test-model",
      historyFile: p.historyFile,
      investigate: async () => {
        investigated += 1;
        return "finding";
      },
      modelProvider: {
        generate: async () => {
          synthesized += 1;
          return { output: "generated" };
        }
      },
      trustLedgerFile: p.trustFile
    });

    expect(repaired).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(providerCalls).toBe(1);
    expect(synthesized).toBe(0);
    expect(investigated).toBe(0);
    expect(brokerCalls).toBe(0);
    expect(existsSync(p.historyFile)).toBe(false);
    expect(existsSync(p.trustFile)).toBe(false);
    expect(await readProactiveFired(p.sidecarFile)).toEqual([
      expect.objectContaining({
        id: "calendar-effect-1",
        kind: "calendar",
        providerEventId: "remote-event-17",
        providerId: "caldav"
      })
    ]);
  });

  it.each([
    ["throwing provider", async (): Promise<OutboundReceipt> => {
      throw new Error("timeout after possible acceptance");
    }],
    ["blank receipt", async (): Promise<OutboundReceipt> => ({
      destination: "@owner",
      messageId: " ",
      providerId: "telegram"
    })]
  ])("seals a %s result unknown without a fired mark or replay", async (_name, send) => {
    const p = paths();
    let providerCalls = 0;
    const first = await runDueProactiveNotices(options(p, messaging(async (message) => {
      providerCalls += 1;
      return send(message);
    })));
    const replay = await runDueProactiveNotices(options(p, new MessagingProviderRegistry([])));

    expect(first.fired).toBe(0);
    expect(first.errors.join("\n")).toContain("delivery is unknown");
    expect(replay.fired).toBe(0);
    expect(replay.errors.join("\n")).toContain("reconcile manually");
    expect(providerCalls).toBe(1);
    expect(await readOutboundEffects(p.effectFile)).toEqual([
      expect.objectContaining({ state: "unknown" })
    ]);
    expect(await readProactiveFired(p.sidecarFile)).toEqual([]);
  });

  it("seals a crash-left prepared effect unknown before provider lookup or composition", async () => {
    const p = paths();
    const effectId = proactiveCalendarOccurrenceEffectId(event());
    await prepareOutboundEffect(p.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: "immutable prior wire payload"
      }),
      providerId: "telegram"
    });
    let synthesized = 0;
    let investigated = 0;
    const result = await runDueProactiveNotices({
      ...options(p, new MessagingProviderRegistry([])),
      activitySource: { lastActivityMs: () => NOW.getTime() },
      agentModel: "test-model",
      agentRuntime: {
        run: async () => {
          synthesized += 1;
          return { response: { output: "generated" } };
        }
      },
      investigate: async () => {
        investigated += 1;
        return "finding";
      }
    });

    expect(result.fired).toBe(0);
    expect(result.errors.join("\n")).toContain("delivery is unknown");
    expect(synthesized).toBe(0);
    expect(investigated).toBe(0);
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "unknown" });
    expect(await readProactiveFired(p.sidecarFile)).toEqual([]);
  });

  it.each(["accepted", "not-delivered"] as const)(
    "repairs reconciled-%s with exact qualified state and no provider or post-delivery egress",
    async (decision) => {
      const p = paths();
      const effectId = proactiveCalendarOccurrenceEffectId(event());
      await prepareOutboundEffect(p.effectFile, {
        createdAt: NOW.toISOString(),
        destination: "@owner",
        effectId,
        payloadHash: computeOutboundEffectPayloadHash({
          destination: "@owner",
          providerId: "telegram",
          text: "prior wire payload"
        }),
        providerId: "telegram"
      });
      await recordOutboundEffectUnknown(
        p.effectFile,
        effectId,
        "provider acceptance was ambiguous",
        NOW.toISOString()
      );
      const recordedAt = "2026-07-27T14:55:01.000Z";
      await reconcileOutboundEffect(p.effectFile, {
        actor: "owner",
        decision,
        effectId,
        reason: "checked provider history",
        ...(decision === "accepted"
          ? {
              receipt: {
                destination: "@owner",
                messageId: "manual-calendar-accepted",
                providerId: "telegram",
                receivedAt: recordedAt
              }
            }
          : {}),
        recordedAt
      });
      let brokerCalls = 0;
      const result = await runDueProactiveNotices({
        ...options(p, new MessagingProviderRegistry([])),
        agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
        agentInitiatedNoticeUserId: "owner",
        historyFile: p.historyFile,
        trustLedgerFile: p.trustFile
      });

      expect(result).toMatchObject({
        errors: [],
        fired: decision === "accepted" ? 1 : 0,
        imminent: 1
      });
      expect(brokerCalls).toBe(0);
      expect(existsSync(p.historyFile)).toBe(false);
      expect(existsSync(p.trustFile)).toBe(false);
      expect(await readProactiveFired(p.sidecarFile)).toEqual([
        expect.objectContaining({
          firedAt: recordedAt,
          id: "calendar-effect-1",
          kind: "calendar",
          providerEventId: "remote-event-17",
          providerId: "caldav"
        })
      ]);
    }
  );

  it("fails route drift closed before provider lookup and preserves payload binding on direct repeat attempts", async () => {
    const route = paths();
    const effectId = proactiveCalendarOccurrenceEffectId(event());
    await prepareOutboundEffect(route.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@different",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@different",
        providerId: "telegram",
        text: "prior wire payload"
      }),
      providerId: "telegram"
    });
    const blocked = await runDueProactiveNotices(options(route, new MessagingProviderRegistry([])));
    expect(blocked.fired).toBe(0);
    expect(blocked.errors.join("\n")).toContain("route binding conflicts");
    expect(await readOutboundEffect(route.effectFile, effectId)).toMatchObject({ state: "prepared" });
    expect(await readProactiveFired(route.sidecarFile)).toEqual([]);

    const payload = paths();
    let providerCalls = 0;
    const directRegistry = messaging(async (message) => {
      providerCalls += 1;
      expect(message.text).not.toContain("sk-12345678901234567890");
      return {
        destination: message.destination,
        messageId: "direct-accepted",
        providerId: "telegram"
      };
    });
    await dispatchOutboundEffectOnce({
      destination: "@owner",
      effectFile: payload.effectFile,
      effectId,
      now: () => NOW,
      providerId: "telegram",
      registry: directRegistry,
      text: "token sk-12345678901234567890 stable"
    });
    await expect(dispatchOutboundEffectOnce({
      destination: "@owner",
      effectFile: payload.effectFile,
      effectId,
      now: () => NOW,
      providerId: "telegram",
      registry: directRegistry,
      text: "token sk-12345678901234567890 drifted"
    })).rejects.toThrow(/different payload/iu);
    expect(providerCalls).toBe(1);
  });

  it("keeps a legacy wildcard suppression effect-free before composition or delivery", async () => {
    const p = paths();
    const raw = `${JSON.stringify({
      fired: [{
        firedAt: "2026-07-27T14:50:00.000Z",
        id: "calendar-effect-1",
        kind: "calendar",
        startIso: START.toISOString()
      }]
    })}\n`;
    writeFileSync(p.sidecarFile, raw, "utf8");
    let synthesized = 0;
    let investigated = 0;
    let providerCalls = 0;
    const result = await runDueProactiveNotices({
      ...options(p, messaging(async () => {
        providerCalls += 1;
        throw new Error("must not send");
      })),
      activitySource: { lastActivityMs: () => NOW.getTime() },
      agentModel: "test-model",
      investigate: async () => {
        investigated += 1;
        return "finding";
      },
      modelProvider: {
        generate: async () => {
          synthesized += 1;
          return { output: "generated" };
        }
      }
    });

    expect(result).toMatchObject({ errors: [], fired: 0, imminent: 1 });
    expect(providerCalls).toBe(0);
    expect(synthesized).toBe(0);
    expect(investigated).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(readFileSync(p.sidecarFile, "utf8")).toBe(raw);
  });

  it("keeps qualified calendar terminal and quiet-hour paths effect-free", async () => {
    const terminal = paths();
    let terminalCalls = 0;
    const terminalResult = await runDueProactiveNotices({
      ...options(terminal, new MessagingProviderRegistry([])),
      activitySource: { lastActivityMs: () => NOW.getTime() },
      terminalSink: { deliver: () => { terminalCalls += 1; } }
    });
    expect(terminalResult).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(terminalCalls).toBe(1);
    expect(existsSync(terminal.effectFile)).toBe(false);

    const quiet = paths();
    let providerCalls = 0;
    const quietResult = await runDueProactiveNotices({
      ...options(quiet, messaging(async () => {
        providerCalls += 1;
        throw new Error("quiet path must not send");
      })),
      quietHours: { endHour: 13, startHour: 14 }
    });
    expect(quietResult).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(providerCalls).toBe(0);
    expect(existsSync(quiet.effectFile)).toBe(false);
  });

  it("uses the surfaced id as the live durable occurrence fallback when providerEventId is absent", async () => {
    const p = paths();
    const fallback = event({ providerEventId: undefined });
    const effectId = proactiveCalendarOccurrenceEffectId(fallback);
    const sent: OutboundMessage[] = [];
    const result = await runDueProactiveNotices(options(p, messaging(async (message) => {
      sent.push(message);
      return {
        destination: message.destination,
        messageId: "fallback-accepted",
        providerId: "telegram"
      };
    }), fallback));

    expect(result).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(sent).toEqual([expect.objectContaining({ idempotencyKey: effectId })]);
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "accepted" });
    const fired = await readProactiveFired(p.sidecarFile);
    expect(fired).toEqual([
      expect.objectContaining({
        id: "calendar-effect-1",
        kind: "calendar",
        providerId: "caldav"
      })
    ]);
    expect(fired[0]).not.toHaveProperty("providerEventId");
  });

  it("uses providerEventId when present and falls back to id while reschedules remain distinct", () => {
    const withRemote = event();
    const fallback = event({ providerEventId: undefined });
    const moved = event({
      providerEventId: undefined,
      startsAt: new Date("2026-07-27T15:03:00.000Z")
    });

    expect(proactiveCalendarOccurrenceEffectId(withRemote))
      .not.toBe(proactiveCalendarOccurrenceEffectId(fallback));
    expect(proactiveCalendarOccurrenceEffectId(fallback))
      .not.toBe(proactiveCalendarOccurrenceEffectId(moved));
  });
});
