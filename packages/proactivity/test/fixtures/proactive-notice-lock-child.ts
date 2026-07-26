import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CalendarProviderRegistry,
  type CalendarProvider
} from "@muse/calendar";
import {
  MessagingProviderRegistry,
  type MessagingProvider
} from "@muse/messaging";

import { runDueProactiveNotices } from "../../src/proactive-notice-loop.js";

interface Input {
  readonly callsFile: string;
  readonly calendarEvent?: {
    readonly id: string;
    readonly providerEventId?: string;
    readonly providerId: string;
    readonly startsAtIso: string;
    readonly title: string;
  };
  readonly effectFile: string;
  readonly nowIso: string;
  readonly sidecarFile: string;
  readonly tasksFile?: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const provider: MessagingProvider = {
  describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
  id: "telegram",
  send: async (message) => {
    await appendFile(input.callsFile, `${process.pid.toString()}\n`);
    await sleep(75);
    return {
      destination: message.destination,
      messageId: `message-${process.pid.toString()}`,
      providerId: "telegram"
    };
  }
};
const calendarRegistry = input.calendarEvent
  ? new CalendarProviderRegistry([{
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
      listEvents: async () => [{
        allDay: false,
        endsAt: new Date(new Date(input.calendarEvent!.startsAtIso).getTime() + 30 * 60_000),
        id: input.calendarEvent!.id,
        ...(input.calendarEvent!.providerEventId !== undefined
          ? { providerEventId: input.calendarEvent!.providerEventId }
          : {}),
        providerId: input.calendarEvent!.providerId,
        startsAt: new Date(input.calendarEvent!.startsAtIso),
        title: input.calendarEvent!.title
      }],
      updateEvent: async () => { throw new Error("not used"); }
    } satisfies CalendarProvider])
  : undefined;
const result = await runDueProactiveNotices({
  ...(calendarRegistry ? { calendarRegistry } : {}),
  destination: "@owner",
  effectFile: input.effectFile,
  heartbeatDir: null,
  messagingRegistry: new MessagingProviderRegistry([provider]),
  now: () => new Date(input.nowIso),
  providerId: "telegram",
  sidecarFile: input.sidecarFile,
  ...(input.tasksFile ? { tasksFile: input.tasksFile } : {})
});
process.stdout.write(`${JSON.stringify(result)}\n`);
