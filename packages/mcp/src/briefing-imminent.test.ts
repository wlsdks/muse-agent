import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deriveBriefingImminent,
  deriveCalendarBriefingImminent,
  type BriefingCalendarEvent
} from "./briefing-imminent.js";
import { writeTasks, type PersistedTask } from "./personal-tasks-store.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-brief-imm-")), "tasks.json");
}

function task(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "t",
    status: "open",
    title: "submit the Q3 report",
    ...overrides
  };
}

const NOW = new Date("2026-05-19T09:00:00.000Z");
const inWindow = "2026-05-19T10:00:00.000Z"; // +60 min (< 120 default)

describe("deriveBriefingImminent — P8-b3: ground the briefing in real imminent tasks", () => {
  it("selects only open, due-soon, proactive tasks — mirrors the proactive imminence rule", async () => {
    const file = tmpFile();
    await writeTasks(file, [
      task({ dueAt: inWindow, id: "ok", title: "submit the Q3 report" }),
      task({ dueAt: inWindow, id: "done", status: "done", title: "finished" }),
      task({ dueAt: "2026-05-19T08:30:00.000Z", id: "past", title: "already past" }),
      task({ dueAt: "2026-05-20T09:00:00.000Z", id: "far", title: "tomorrow, out of window" }),
      task({ dueAt: inWindow, id: "muted", proactive: false, title: "opted out" }),
      task({ dueAt: "not-a-date", id: "bad", title: "unparseable dueAt" }),
      task({ id: "nodue", title: "no dueAt at all" })
    ]);
    const imminent = await deriveBriefingImminent(file, { now: NOW });
    expect(imminent).toEqual([
      { kind: "task", startsAt: new Date(inWindow), title: "submit the Q3 report" }
    ]);
  });

  it("respects leadMinutes and a missing store is empty (no throw)", async () => {
    const file = tmpFile();
    await writeTasks(file, [task({ dueAt: inWindow })]);
    // 30-min window excludes the +60-min task.
    expect(await deriveBriefingImminent(file, { leadMinutes: 30, now: NOW })).toEqual([]);
    expect(await deriveBriefingImminent(join(tmpdir(), "nope-tasks.json"), { now: NOW })).toEqual([]);
  });
});

describe("deriveCalendarBriefingImminent — P8-b4: ground the briefing in real imminent calendar events", () => {
  function ev(overrides: Partial<BriefingCalendarEvent> = {}): BriefingCalendarEvent {
    return { allDay: false, startsAt: new Date(inWindow), title: "Q3 review", ...overrides };
  }

  it("selects only timed, in-window, non-opted-out events — mirrors the proactive calendar rule", async () => {
    const events: BriefingCalendarEvent[] = [
      ev({ title: "Q3 review" }),
      ev({ allDay: true, title: "all-day offsite" }),
      ev({ startsAt: new Date("not-a-date"), title: "broken feed" }),
      ev({ startsAt: new Date("2026-05-19T08:30:00.000Z"), title: "already past" }),
      ev({ startsAt: new Date("2026-05-20T09:00:00.000Z"), title: "tomorrow, out of window" }),
      ev({ title: "secret [no-proactive] sync" }),
      ev({ notes: "muted [no-proactive]", title: "1:1" })
    ];
    const imminent = await deriveCalendarBriefingImminent(async () => events, { now: NOW });
    expect(imminent).toEqual([{ kind: "calendar", startsAt: new Date(inWindow), title: "Q3 review" }]);
  });

  it("passes a [now, now+lead] range to the lister; a throwing lister is fail-soft", async () => {
    let seen: { from: Date; to: Date } | undefined;
    await deriveCalendarBriefingImminent(async (r) => {
      seen = r;
      return [];
    }, { leadMinutes: 90, now: NOW });
    expect(seen).toEqual({ from: NOW, to: new Date(NOW.getTime() + 90 * 60_000) });
    expect(
      await deriveCalendarBriefingImminent(async () => {
        throw new Error("calendar provider down");
      }, { now: NOW })
    ).toEqual([]);
  });
});
