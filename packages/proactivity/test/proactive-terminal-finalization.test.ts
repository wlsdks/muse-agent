import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
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
  type MessagingProvider,
  type OutboundMessage
} from "@muse/messaging";
import {
  readProactiveFired,
  readProactiveHeartbeat,
  writeTasks
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import { runDueProactiveNotices } from "../src/proactive-notice-loop.js";

const NOW = new Date("2026-07-27T03:00:00.000Z");
const TASK_DUE_AT = "2026-07-27T03:05:00.000Z";
const CALENDAR_START = new Date("2026-07-27T03:04:00.000Z");

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-proactive-terminal-finalization-"));
  return {
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    heartbeatDir: join(dir, "heartbeat"),
    historyFile: join(dir, "proactive-history.json"),
    sidecarFile: join(dir, "proactive-fired.json"),
    tasksFile: join(dir, "tasks.json"),
    trustFile: join(dir, "proactive-trust.json")
  };
}

async function seedTask(p: ReturnType<typeof paths>, id = "terminal-task"): Promise<void> {
  await writeTasks(p.tasksFile, [{
    createdAt: "2026-07-27T02:00:00.000Z",
    dueAt: TASK_DUE_AT,
    id,
    status: "open",
    title: "Terminal task"
  }]);
}

function calendarEvent(): CalendarEvent {
  return {
    allDay: false,
    endsAt: new Date("2026-07-27T03:34:00.000Z"),
    id: "terminal-calendar",
    providerEventId: "remote-terminal-calendar",
    providerId: "caldav",
    startsAt: CALENDAR_START,
    title: "Terminal calendar"
  };
}

function calendarRegistry(): CalendarProviderRegistry {
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
    listEvents: async () => [calendarEvent()],
    updateEvent: async () => { throw new Error("not used"); }
  };
  return new CalendarProviderRegistry([provider]);
}

function messaging(onSend?: (message: OutboundMessage) => void): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    send: async (message) => {
      onSend?.(message);
      return {
        destination: message.destination,
        messageId: "unexpected-messaging",
        providerId: "telegram"
      };
    }
  };
  return new MessagingProviderRegistry([provider]);
}

function terminalBase(p: ReturnType<typeof paths>) {
  return {
    activitySource: { lastActivityMs: () => NOW.getTime() },
    destination: "@owner",
    effectFile: p.effectFile,
    heartbeatDir: null,
    messagingRegistry: messaging(),
    now: () => NOW,
    providerId: "telegram",
    sidecarFile: p.sidecarFile
  } as const;
}

describe("proactive terminal loss-biased finalization", () => {
  it("persists exact task and qualified calendar identities before successful terminal delivery", async () => {
    const task = paths();
    await seedTask(task);
    let taskTerminalCalls = 0;
    const taskResult = await runDueProactiveNotices({
      ...terminalBase(task),
      tasksFile: task.tasksFile,
      terminalSink: {
        deliver: async () => {
          taskTerminalCalls += 1;
          expect(await readProactiveFired(task.sidecarFile)).toEqual([
            expect.objectContaining({
              id: "terminal-task",
              kind: "task",
              startIso: TASK_DUE_AT
            })
          ]);
        }
      }
    });
    expect(taskResult).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(taskTerminalCalls).toBe(1);
    expect(existsSync(task.effectFile)).toBe(false);

    const calendar = paths();
    let calendarTerminalCalls = 0;
    let brokerCalls = 0;
    const calendarResult = await runDueProactiveNotices({
      ...terminalBase(calendar),
      agentInitiatedNoticeBroker: {
        publish: () => {
          brokerCalls += 1;
          expect(readFileSync(calendar.sidecarFile, "utf8")).toContain("remote-terminal-calendar");
        }
      },
      agentInitiatedNoticeUserId: "owner",
      calendarRegistry: calendarRegistry(),
      historyFile: calendar.historyFile,
      terminalSink: {
        deliver: async () => {
          calendarTerminalCalls += 1;
          expect(await readProactiveFired(calendar.sidecarFile)).toEqual([
            expect.objectContaining({
              id: "terminal-calendar",
              kind: "calendar",
              providerEventId: "remote-terminal-calendar",
              providerId: "caldav",
              startIso: CALENDAR_START.toISOString()
            })
          ]);
        }
      },
      trustLedgerFile: calendar.trustFile
    });
    expect(calendarResult).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(calendarTerminalCalls).toBe(1);
    expect(brokerCalls).toBe(1);
    expect(existsSync(calendar.historyFile)).toBe(true);
    expect(existsSync(calendar.trustFile)).toBe(true);
    expect(existsSync(calendar.effectFile)).toBe(false);
  });

  it("does no terminal or post-delivery work when the pre-delivery sidecar persistence fails, then safely retries", async () => {
    const p = paths();
    await seedTask(p, "terminal-persist-retry");
    let persistenceFailureInjected = false;
    const failingActivitySource = {
      lastActivityMs: () => {
        if (!persistenceFailureInjected) {
          persistenceFailureInjected = true;
          mkdirSync(p.sidecarFile);
        }
        return NOW.getTime();
      }
    };
    let terminalCalls = 0;
    let brokerCalls = 0;
    let synthesized = 0;
    let investigated = 0;
    const failed = await runDueProactiveNotices({
      ...terminalBase(p),
      activitySource: failingActivitySource,
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
      tasksFile: p.tasksFile,
      terminalSink: { deliver: () => { terminalCalls += 1; } },
      trustLedgerFile: p.trustFile
    });

    expect(failed.fired).toBe(0);
    expect(failed.errors.join("\n")).toContain("terminal pre-delivery state persistence failed");
    expect(terminalCalls).toBe(0);
    expect(brokerCalls).toBe(0);
    expect(synthesized).toBe(0);
    expect(investigated).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(existsSync(p.historyFile)).toBe(false);
    expect(existsSync(p.trustFile)).toBe(false);
    rmSync(p.sidecarFile, { force: true, recursive: true });
    expect(await readProactiveFired(p.sidecarFile)).toEqual([]);

    const retry = await runDueProactiveNotices({
      ...terminalBase(p),
      tasksFile: p.tasksFile,
      terminalSink: { deliver: () => { terminalCalls += 1; } }
    });
    expect(retry).toMatchObject({ errors: [], fired: 1, imminent: 1 });
    expect(terminalCalls).toBe(1);
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);
  });

  it.each([
    ["throw", new Error("injected terminal crash")],
    ["cancel", new DOMException("terminal cancelled", "AbortError")]
  ])("seals a terminal %s loss-biased and never retries or backfills another surface", async (_name, failure) => {
    const p = paths();
    let terminalCalls = 0;
    let brokerCalls = 0;
    let providerCalls = 0;
    const failed = await runDueProactiveNotices({
      ...terminalBase(p),
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      calendarRegistry: calendarRegistry(),
      heartbeatDir: p.heartbeatDir,
      historyFile: p.historyFile,
      terminalSink: {
        deliver: async () => {
          terminalCalls += 1;
          expect(await readProactiveFired(p.sidecarFile)).toEqual([
            expect.objectContaining({
              id: "terminal-calendar",
              kind: "calendar",
              providerEventId: "remote-terminal-calendar",
              providerId: "caldav"
            })
          ]);
          throw failure;
        }
      },
      trustLedgerFile: p.trustFile
    });

    expect(failed.fired).toBe(0);
    expect(failed.errors.join("\n")).toContain(failure.message);
    expect(terminalCalls).toBe(1);
    expect(brokerCalls).toBe(0);
    expect(existsSync(p.trustFile)).toBe(false);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);
    expect(await readProactiveHeartbeat(p.heartbeatDir)).toMatchObject({
      alive: { at: NOW.toISOString() }
    });
    expect((await readProactiveHeartbeat(p.heartbeatDir)).fired).toBeUndefined();
    const historyAfterFailure = readFileSync(p.historyFile, "utf8");

    const terminalRestart = await runDueProactiveNotices({
      ...terminalBase(p),
      calendarRegistry: calendarRegistry(),
      terminalSink: { deliver: () => { terminalCalls += 1; } }
    });
    const messagingFallback = await runDueProactiveNotices({
      calendarRegistry: calendarRegistry(),
      destination: "@owner",
      effectFile: p.effectFile,
      heartbeatDir: null,
      messagingRegistry: messaging(() => { providerCalls += 1; }),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile: p.sidecarFile
    });

    expect(terminalRestart).toMatchObject({ errors: [], fired: 0, imminent: 1 });
    expect(messagingFallback).toMatchObject({ errors: [], fired: 0, imminent: 1 });
    expect(terminalCalls).toBe(1);
    expect(providerCalls).toBe(0);
    expect(brokerCalls).toBe(0);
    expect(existsSync(p.trustFile)).toBe(false);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(readFileSync(p.historyFile, "utf8")).toBe(historyAfterFailure);
  });

  it("keeps a sealed terminal failure explicit when best-effort failure history cannot be written", async () => {
    const p = paths();
    mkdirSync(p.historyFile);
    const result = await runDueProactiveNotices({
      ...terminalBase(p),
      calendarRegistry: calendarRegistry(),
      historyFile: p.historyFile,
      terminalSink: {
        deliver: () => {
          throw new Error("terminal failed before output");
        }
      }
    });

    expect(result.fired).toBe(0);
    expect(result.errors.join("\n")).toContain("terminal failed before output");
    expect(result.errors.join("\n")).toContain("terminal failure history write failed");
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);
    expect(existsSync(p.effectFile)).toBe(false);
  });

  it("keeps terminal success delivered when a later history post-effect fails", async () => {
    const p = paths();
    mkdirSync(p.historyFile);
    let terminalCalls = 0;
    let brokerCalls = 0;
    const result = await runDueProactiveNotices({
      ...terminalBase(p),
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      calendarRegistry: calendarRegistry(),
      historyFile: p.historyFile,
      terminalSink: { deliver: () => { terminalCalls += 1; } },
      trustLedgerFile: p.trustFile
    });

    expect(result.fired).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("terminal post-delivery effects failed");
    expect(result.errors[0]).not.toContain("terminal failure history write failed");
    expect(terminalCalls).toBe(1);
    expect(brokerCalls).toBe(1);
    expect(existsSync(p.trustFile)).toBe(true);
    expect(await readProactiveFired(p.sidecarFile)).toHaveLength(1);
    expect(existsSync(p.effectFile)).toBe(false);

    const restart = await runDueProactiveNotices({
      ...terminalBase(p),
      calendarRegistry: calendarRegistry(),
      historyFile: p.historyFile,
      terminalSink: { deliver: () => { terminalCalls += 1; } },
      trustLedgerFile: p.trustFile
    });
    expect(restart).toMatchObject({ errors: [], fired: 0, imminent: 1 });
    expect(terminalCalls).toBe(1);
    expect(brokerCalls).toBe(1);
  });
});
