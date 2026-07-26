import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CalendarProviderRegistry, type CalendarProvider } from "@muse/calendar";
import {
  MessagingProviderRegistry,
  computeOutboundEffectPayloadHash,
  prepareOutboundEffect,
  readOutboundEffect,
  readOutboundEffects,
  reconcileOutboundEffect,
  recordOutboundEffectUnknown,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import { readProactiveFired, writeTasks } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  proactiveTaskOccurrenceEffectId,
  runDueProactiveNotices
} from "../src/proactive-notice-loop.js";

const NOW = new Date("2026-07-27T03:00:00.000Z");
const DUE_AT = "2026-07-27T03:05:00.000Z";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-proactive-task-effect-"));
  return {
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    historyFile: join(dir, "proactive-history.json"),
    sidecarFile: join(dir, "proactive-fired.json"),
    tasksFile: join(dir, "tasks.json"),
    trustFile: join(dir, "proactive-trust.json")
  };
}

async function seedTask(p: ReturnType<typeof paths>, id = "task-effect-1"): Promise<void> {
  await writeTasks(p.tasksFile, [{
    createdAt: "2026-07-27T02:00:00.000Z",
    dueAt: DUE_AT,
    id,
    status: "open",
    title: "Ship release"
  }]);
}

function registry(
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
  messagingRegistry: MessagingProviderRegistry
) {
  return {
    destination: "@owner",
    effectFile: p.effectFile,
    heartbeatDir: null,
    messagingRegistry,
    now: () => NOW,
    providerId: "telegram",
    sidecarFile: p.sidecarFile,
    tasksFile: p.tasksFile
  } as const;
}

describe("proactive imminent-task durable messaging effect", () => {
  it("binds the exact neutralized wire payload and persists the item sidecar before post-delivery effects", async () => {
    const p = paths();
    await seedTask(p);
    const sent: OutboundMessage[] = [];
    let brokerCalls = 0;
    const effectId = proactiveTaskOccurrenceEffectId("task-effect-1", DUE_AT);
    const summary = await runDueProactiveNotices({
      ...options(p, registry(async (message) => {
        expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "prepared" });
        expect(await readProactiveFired(p.sidecarFile)).toEqual([]);
        sent.push(message);
        return { destination: message.destination, messageId: "accepted-1", providerId: "telegram" };
      })),
      agentInitiatedNoticeBroker: {
        publish: () => {
          brokerCalls += 1;
          expect(readFileSync(p.sidecarFile, "utf8")).toContain("task-effect-1");
        }
      },
      agentInitiatedNoticeUserId: "owner",
      historyFile: p.historyFile,
      trustLedgerFile: p.trustFile
    });

    expect(effectId).toMatch(/^proactive-imminent:[0-9a-f]{64}$/u);
    expect(summary).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(sent).toEqual([
      expect.objectContaining({
        destination: "@owner",
        idempotencyKey: effectId,
        text: "📋 Ship release due in 5 min"
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
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);
  });

  it("repairs accepted state after a sidecar crash without provider, synthesis, investigation, trust, broker, or history replay", async () => {
    const p = paths();
    await seedTask(p, "task-repair");
    let providerCalls = 0;
    const first = await runDueProactiveNotices(options(p, registry(async (message) => {
      providerCalls += 1;
      rmSync(p.sidecarFile, { force: true });
      mkdirSync(p.sidecarFile);
      return { destination: message.destination, messageId: "accepted-before-crash", providerId: "telegram" };
    })));
    expect(first.fired).toBe(0);
    expect((await readOutboundEffects(p.effectFile)).map((effect) => effect.state)).toEqual(["accepted"]);
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
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);
  });

  it("seals ambiguous sends and crash-left prepared effects as unknown without replay or a fired mark", async () => {
    const p = paths();
    await seedTask(p, "task-unknown");
    let providerCalls = 0;
    const active = options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("timeout after possible acceptance");
    }));
    const first = await runDueProactiveNotices(active);
    const replay = await runDueProactiveNotices({
      ...active,
      messagingRegistry: new MessagingProviderRegistry([])
    });
    expect(first.errors.join("\n")).toContain("delivery is unknown");
    expect(replay.errors.join("\n")).toContain("reconcile manually");
    expect(providerCalls).toBe(1);
    expect(await readProactiveFired(p.sidecarFile)).toEqual([]);

    const prepared = paths();
    await seedTask(prepared, "task-prepared");
    const effectId = proactiveTaskOccurrenceEffectId("task-prepared", DUE_AT);
    await prepareOutboundEffect(prepared.effectFile, {
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
    const sealed = await runDueProactiveNotices(options(prepared, new MessagingProviderRegistry([])));
    expect(sealed.errors.join("\n")).toContain("delivery is unknown");
    expect(await readOutboundEffect(prepared.effectFile, effectId)).toMatchObject({ state: "unknown" });
    expect(await readProactiveFired(prepared.sidecarFile)).toEqual([]);
  });

  it("marks reconciled-not-delivered as sealed and fails route drift closed without any provider call", async () => {
    const p = paths();
    await seedTask(p, "task-reconciled");
    const effectId = proactiveTaskOccurrenceEffectId("task-reconciled", DUE_AT);
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
    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId,
      reason: "provider history has no message",
      recordedAt: NOW.toISOString()
    });
    const sealed = await runDueProactiveNotices(options(p, new MessagingProviderRegistry([])));
    expect(sealed).toMatchObject({ errors: [], fired: 0, imminent: 1 });
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);

    const drift = paths();
    await seedTask(drift, "task-drift");
    const driftId = proactiveTaskOccurrenceEffectId("task-drift", DUE_AT);
    await prepareOutboundEffect(drift.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@different",
      effectId: driftId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@different",
        providerId: "telegram",
        text: "prior wire payload"
      }),
      providerId: "telegram"
    });
    const blocked = await runDueProactiveNotices(options(drift, new MessagingProviderRegistry([])));
    expect(blocked.errors.join("\n")).toContain("route binding conflicts");
    expect(await readOutboundEffect(drift.effectFile, driftId)).toMatchObject({ state: "prepared" });
    expect(await readProactiveFired(drift.sidecarFile)).toEqual([]);
  });

  it("keeps task terminal and quiet-hour paths effect-free", async () => {
    const terminal = paths();
    await seedTask(terminal, "task-terminal");
    let terminalCalls = 0;
    const terminalResult = await runDueProactiveNotices({
      ...options(terminal, new MessagingProviderRegistry([])),
      activitySource: { lastActivityMs: () => NOW.getTime() },
      terminalSink: { deliver: () => { terminalCalls += 1; } }
    });
    expect(terminalResult.fired).toBe(1);
    expect(terminalCalls).toBe(1);
    expect(existsSync(terminal.effectFile)).toBe(false);

    const quiet = paths();
    await seedTask(quiet, "task-quiet");
    const quietResult = await runDueProactiveNotices({
      ...options(quiet, registry(async () => {
        throw new Error("quiet path must not send");
      })),
      quietHours: { endHour: 23, startHour: 0 }
    });
    expect(quietResult.fired).toBe(1);
    expect(existsSync(quiet.effectFile)).toBe(false);
  });

  it("persists task acceptance immediately while retaining calendar's end-of-tick batch semantics", async () => {
    const p = paths();
    await seedTask(p, "task-after-calendar");
    const calendar: CalendarProvider = {
      createEvent: async () => { throw new Error("not used"); },
      deleteEvent: async () => { throw new Error("not used"); },
      describe: () => ({
        credentials: [],
        description: "test",
        displayName: "Test",
        id: "calendar",
        local: true
      }),
      id: "calendar",
      listEvents: async () => [{
        allDay: false,
        endsAt: new Date("2026-07-27T03:30:00.000Z"),
        id: "calendar-first",
        providerId: "calendar",
        startsAt: new Date("2026-07-27T03:01:00.000Z"),
        title: "Calendar first"
      }],
      updateEvent: async () => { throw new Error("not used"); }
    };
    let providerCalls = 0;
    const summary = await runDueProactiveNotices({
      ...options(p, registry(async (message) => {
        providerCalls += 1;
        if (providerCalls === 2) {
          expect(await readProactiveFired(p.sidecarFile)).toEqual([]);
        }
        return {
          destination: message.destination,
          messageId: `accepted-${providerCalls.toString()}`,
          providerId: "telegram"
        };
      })),
      calendarRegistry: new CalendarProviderRegistry([calendar])
    });

    expect(summary).toMatchObject({ errors: [], fired: 2, imminent: 2 });
    expect(providerCalls).toBe(2);
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
    expect(await readProactiveFired(p.sidecarFile)).toEqual([
      expect.objectContaining({ id: "calendar-first", kind: "calendar" }),
      expect.objectContaining({ id: "task-after-calendar", kind: "task" })
    ]);
  });
});
