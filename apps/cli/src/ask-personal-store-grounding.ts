/**
 * CLI binding of `@muse/recall`'s personal-store grounding stage: store paths
 * and the calendar-provider registry resolve through `@muse/autoconfigure` at
 * CALL time (the package must not import autoconfigure — cycle).
 */

import { buildCalendarRegistry, resolveContactsFile, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import type { CalendarEvent } from "@muse/calendar";
import {
  buildPersonalStoreGrounding as buildPersonalStoreGroundingCore,
  type PersonalStoreGrounding
} from "@muse/recall";

export type { PersonalStoreGrounding } from "@muse/recall";

type CoreParams = Parameters<typeof buildPersonalStoreGroundingCore>[0];

/** Merge events across every registered provider; one failing provider keeps the rest. */
async function listRegisteredCalendarEvents(range: { readonly from: Date; readonly to: Date }): Promise<readonly CalendarEvent[]> {
  const registry = buildCalendarRegistry(process.env as Record<string, string | undefined>);
  const collected: CalendarEvent[] = [];
  for (const provider of registry.list()) {
    try {
      collected.push(...(await provider.listEvents({ from: range.from, to: range.to })));
    } catch {
      // single provider failed (auth lapsed, network) — keep what we got
    }
  }
  return collected;
}

export async function buildPersonalStoreGrounding(
  params: Omit<CoreParams, "tasksFile" | "remindersFile" | "contactsFile" | "listCalendarEvents">
): Promise<PersonalStoreGrounding> {
  const env = process.env as Record<string, string | undefined>;
  return buildPersonalStoreGroundingCore({
    ...params,
    contactsFile: resolveContactsFile(env),
    listCalendarEvents: listRegisteredCalendarEvents,
    remindersFile: resolveRemindersFile(env),
    tasksFile: resolveTasksFile(env)
  });
}
