import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CalendarProviderRegistry,
  type CalendarEvent,
  type CalendarProvider
} from "@muse/calendar";
import {
  MessagingProviderRegistry,
  type MessagingProvider,
  type OutboundMessage
} from "@muse/messaging";
import { readProactiveFired } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { runDueProactiveNotices } from "../src/proactive-notice-loop.js";

const NOW = new Date("2026-07-27T14:55:00.000Z");
const START = new Date("2026-07-27T15:00:00.000Z");

function calendarProvider(
  id: string,
  events: () => readonly CalendarEvent[]
): CalendarProvider {
  return {
    createEvent: async () => { throw new Error("not used"); },
    deleteEvent: async () => { throw new Error("not used"); },
    describe: () => ({
      credentials: [],
      description: "test",
      displayName: id,
      id,
      local: true
    }),
    id,
    listEvents: async () => events(),
    updateEvent: async () => { throw new Error("not used"); }
  };
}

function event(
  providerId: string,
  overrides: Partial<CalendarEvent> = {}
): CalendarEvent {
  return {
    allDay: false,
    endsAt: new Date("2026-07-27T15:30:00.000Z"),
    id: "shared-event",
    providerEventId: `${providerId}-raw`,
    providerId,
    startsAt: START,
    title: `${providerId} review`,
    ...overrides
  };
}

function messaging(sent: OutboundMessage[]): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    send: async (message) => {
      sent.push(message);
      return {
        destination: message.destination,
        messageId: `message-${sent.length.toString()}`,
        providerId: "telegram"
      };
    }
  };
  return new MessagingProviderRegistry([provider]);
}

function sidecar(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-proactive-calendar-v2-")), "proactive-fired.json");
}

describe("proactive calendar v2 occurrence dedupe", () => {
  it("dedupes same-id/start providers independently, ignores title drift, and re-fires a rescheduled occurrence", async () => {
    const sidecarFile = sidecar();
    const sent: OutboundMessage[] = [];
    let caldav = event("caldav");
    let google = event("google");
    const calendarRegistry = new CalendarProviderRegistry([
      calendarProvider("caldav", () => [caldav]),
      calendarProvider("google", () => [google])
    ]);
    const options = {
      calendarRegistry,
      destination: "@owner",
      heartbeatDir: null,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    } as const;

    const first = await runDueProactiveNotices(options);
    expect(first).toMatchObject({ errors: [], fired: 2, imminent: 2 });
    expect(sent).toHaveLength(2);
    expect(await readProactiveFired(sidecarFile)).toEqual([
      expect.objectContaining({
        id: "shared-event",
        kind: "calendar",
        providerEventId: "caldav-raw",
        providerId: "caldav",
        startIso: START.toISOString()
      }),
      expect.objectContaining({
        id: "shared-event",
        kind: "calendar",
        providerEventId: "google-raw",
        providerId: "google",
        startIso: START.toISOString()
      })
    ]);

    caldav = event("caldav", { title: "renamed without occurrence change" });
    google = event("google", { title: "another renamed title" });
    const titleOnly = await runDueProactiveNotices(options);
    expect(titleOnly).toMatchObject({ fired: 0, imminent: 2 });
    expect(sent).toHaveLength(2);

    const moved = new Date("2026-07-27T15:03:00.000Z");
    caldav = event("caldav", { startsAt: moved, title: "renamed and moved" });
    const rescheduled = await runDueProactiveNotices(options);
    expect(rescheduled).toMatchObject({ errors: [], fired: 1, imminent: 2 });
    expect(sent).toHaveLength(3);
    expect(await readProactiveFired(sidecarFile)).toContainEqual(expect.objectContaining({
      id: "shared-event",
      providerEventId: "caldav-raw",
      providerId: "caldav",
      startIso: moved.toISOString()
    }));
  });

  it("treats an unversioned calendar occurrence as a provider-neutral wildcard without rewriting it", async () => {
    const sidecarFile = sidecar();
    const legacy = {
      fired: [{
        firedAt: "2026-07-27T14:50:00.000Z",
        id: "shared-event",
        kind: "calendar",
        startIso: START.toISOString()
      }]
    };
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(sidecarFile, raw, "utf8");
    const sent: OutboundMessage[] = [];
    const calendarRegistry = new CalendarProviderRegistry([
      calendarProvider("caldav", () => [event("caldav")]),
      calendarProvider("google", () => [event("google")])
    ]);

    const summary = await runDueProactiveNotices({
      calendarRegistry,
      destination: "@owner",
      heartbeatDir: null,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    });

    expect(summary).toMatchObject({ errors: [], fired: 0, imminent: 2 });
    expect(sent).toEqual([]);
    expect(readFileSync(sidecarFile, "utf8")).toBe(raw);
    expect(await readProactiveFired(sidecarFile)).toEqual(legacy.fired);
  });

  it("fails closed on an invalid sidecar without delivery or overwrite", async () => {
    const sidecarFile = sidecar();
    const raw = JSON.stringify({
      fired: [{
        firedAt: "2026-07-27T14:50:00.000Z",
        id: "shared-event",
        kind: "calendar",
        providerEventId: "partial-without-provider",
        startIso: START.toISOString()
      }],
      version: 2
    });
    writeFileSync(sidecarFile, raw, "utf8");
    const sent: OutboundMessage[] = [];

    await expect(runDueProactiveNotices({
      calendarRegistry: new CalendarProviderRegistry([
        calendarProvider("caldav", () => [event("caldav")])
      ]),
      destination: "@owner",
      heartbeatDir: null,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    })).rejects.toThrow(/invalid calendar provenance/iu);

    expect(sent).toEqual([]);
    expect(readFileSync(sidecarFile, "utf8")).toBe(raw);
  });

  it.each([
    ["numeric-like firedAt", { firedAt: "0" }],
    ["impossible startIso", { startIso: "2026-02-30T00:00:00.000Z" }]
  ])("fails closed on %s in the sidecar with zero delivery and unchanged bytes", async (_name, overrides) => {
    const sidecarFile = sidecar();
    const raw = `${JSON.stringify({
      fired: [{
        firedAt: "2026-07-27T14:50:00.000Z",
        id: "shared-event",
        kind: "calendar",
        providerEventId: "caldav-raw",
        providerId: "caldav",
        startIso: START.toISOString(),
        ...overrides
      }],
      version: 2
    })}\n`;
    writeFileSync(sidecarFile, raw, "utf8");
    const sent: OutboundMessage[] = [];

    await expect(runDueProactiveNotices({
      calendarRegistry: new CalendarProviderRegistry([
        calendarProvider("caldav", () => [event("caldav")])
      ]),
      destination: "@owner",
      heartbeatDir: null,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    })).rejects.toThrow(/invalid (firedAt|startIso)/iu);

    expect(sent).toEqual([]);
    expect(readFileSync(sidecarFile, "utf8")).toBe(raw);
  });

  it("fails closed on partial live calendar provenance before delivery or sidecar creation", async () => {
    const sidecarFile = sidecar();
    const sent: OutboundMessage[] = [];

    await expect(runDueProactiveNotices({
      calendarRegistry: new CalendarProviderRegistry([
        calendarProvider("caldav", () => [event("caldav", { providerEventId: "" })])
      ]),
      destination: "@owner",
      heartbeatDir: null,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    })).rejects.toThrow(/invalid calendar providerEventId/iu);

    expect(sent).toEqual([]);
    expect(existsSync(sidecarFile)).toBe(false);
  });

  it("preflights every imminent candidate before the first external effect", async () => {
    const sidecarFile = sidecar();
    const dir = join(sidecarFile, "..");
    const effectFile = join(dir, "outbound-effects.json");
    const historyFile = join(dir, "proactive-history.json");
    const trustLedgerFile = join(dir, "proactive-trust.json");
    const raw = "{\"version\":2,\"fired\":[]}\n";
    writeFileSync(sidecarFile, raw, "utf8");
    const sent: OutboundMessage[] = [];
    let brokerCalls = 0;
    const first = event("caldav", {
      id: "valid-first",
      providerEventId: "valid-first-raw",
      startsAt: START,
      title: "Valid first"
    });
    const invalidLater = event("caldav", {
      id: "invalid-later",
      providerEventId: "invalid-later-raw",
      providerId: "",
      startsAt: new Date("2026-07-27T15:01:00.000Z"),
      title: "Invalid later"
    });

    await expect(runDueProactiveNotices({
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      calendarRegistry: new CalendarProviderRegistry([
        calendarProvider("caldav", () => [first, invalidLater])
      ]),
      destination: "@owner",
      effectFile,
      heartbeatDir: null,
      historyFile,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      trustLedgerFile
    })).rejects.toThrow(/invalid calendar providerId/iu);

    expect(sent).toEqual([]);
    expect(brokerCalls).toBe(0);
    expect(readFileSync(sidecarFile, "utf8")).toBe(raw);
    expect(existsSync(historyFile)).toBe(false);
    expect(existsSync(trustLedgerFile)).toBe(false);
    expect(existsSync(effectFile)).toBe(false);
  });

  it("rejects a later whitespace-only live id before delivering an earlier valid candidate", async () => {
    const sidecarFile = sidecar();
    const raw = "{\"version\":2,\"fired\":[]}\n";
    writeFileSync(sidecarFile, raw, "utf8");
    const sent: OutboundMessage[] = [];
    const first = event("caldav", {
      id: "valid-first",
      providerEventId: "valid-first-raw",
      startsAt: START
    });
    const invalidLater = event("caldav", {
      id: " \t ",
      providerEventId: "invalid-id-raw",
      startsAt: new Date("2026-07-27T15:01:00.000Z")
    });

    await expect(runDueProactiveNotices({
      calendarRegistry: new CalendarProviderRegistry([
        calendarProvider("caldav", () => [first, invalidLater])
      ]),
      destination: "@owner",
      heartbeatDir: null,
      messagingRegistry: messaging(sent),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile
    })).rejects.toThrow(/invalid id/iu);

    expect(sent).toEqual([]);
    expect(readFileSync(sidecarFile, "utf8")).toBe(raw);
  });
});
