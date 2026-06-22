import { describe, expect, it } from "vitest";

import { createCalendarMcpServer } from "../src/index.js";

// A registry that mirrors the LocalCalendarProvider's INVALID_TIME_RANGE guard
// (local-provider.ts) and captures the resolved input, so we test the add tool
// end-to-end: a bare time-of-day `endsAt` must anchor to the START's day, not today.
function capturingRegistry() {
  let captured: { startsAt: Date; endsAt: Date } | undefined;
  const registry = {
    createEvent: async (_providerId: string, input: { startsAt: Date; endsAt: Date; title: string }) => {
      if (input.endsAt.getTime() < input.startsAt.getTime()) {
        throw new Error("endsAt must be at or after startsAt");
      }
      captured = { endsAt: input.endsAt, startsAt: input.startsAt };
      return { endsAt: input.endsAt, id: "e1", providerId: "local", startsAt: input.startsAt, title: input.title };
    },
    deleteEvent: async () => undefined,
    listEvents: async () => [],
    updateEvent: async () => ({})
  } as unknown as Parameters<typeof createCalendarMcpServer>[0]["registry"];
  return { registry, captured: () => captured };
}

function addTool() {
  const cap = capturingRegistry();
  const server = createCalendarMcpServer({ registry: cap.registry });
  const add = server.tools.find((t) => t.name === "add")!;
  return { add, captured: cap.captured };
}

describe("muse.calendar.add — a time-only endsAt anchors to the START's day, not today", () => {
  it("EN: 'tomorrow 3pm' + '4pm' creates an event ending tomorrow 16:00 (not today)", async () => {
    const { add, captured } = addTool();
    const result = await add.execute({ endsAt: "4pm", startsAt: "tomorrow 3pm", title: "Team sync" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error"); // was: "endsAt must be at or after startsAt"
    const c = captured()!;
    expect(c.startsAt.getHours()).toBe(15);
    expect(c.endsAt.getHours()).toBe(16);
    expect(c.endsAt.getDate()).toBe(c.startsAt.getDate()); // SAME (start's) day, not today
    expect(c.endsAt.getTime()).toBeGreaterThan(c.startsAt.getTime());
  });

  it("KO: '다음 주 월요일 오후 3시' + '오후 4시' ends on the start's day at 16:00", async () => {
    const { add, captured } = addTool();
    const result = await add.execute({ endsAt: "오후 4시", startsAt: "다음 주 월요일 오후 3시", title: "회의" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    const c = captured()!;
    expect(c.endsAt.getHours()).toBe(16);
    expect(c.endsAt.getDate()).toBe(c.startsAt.getDate());
    expect(c.endsAt.getTime()).toBeGreaterThan(c.startsAt.getTime());
  });
});

describe("muse.calendar.update — moving to a new day re-anchors a time-only endsAt to the NEW day", () => {
  it("'move to 2026-06-20 15:00, ending 5pm' lands the end on June 20, not the original (Jan 10) day", async () => {
    const existing = { endsAt: new Date(2026, 0, 10, 16, 0), id: "e1", providerId: "local", startsAt: new Date(2026, 0, 10, 15, 0), title: "Standup" };
    let captured: { startsAt: Date; endsAt: Date } | undefined;
    const registry = {
      createEvent: async () => ({}),
      deleteEvent: async () => undefined,
      listEvents: async () => [existing],
      updateEvent: async (_pid: string, _id: string, update: { startsAt: Date; endsAt: Date }) => { captured = update; return { ...existing, ...update }; }
    } as unknown as Parameters<typeof createCalendarMcpServer>[0]["registry"];
    const server = createCalendarMcpServer({ registry });
    const update = server.tools.find((t) => t.name === "update")!;
    const result = await update.execute({ endsAt: "5pm", id: "e1", startsAt: "2026-06-20T15:00:00" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    const c = captured!;
    expect(c.endsAt.getMonth()).toBe(5); // June — the NEW day, not January (the original)
    expect(c.endsAt.getDate()).toBe(20);
    expect(c.endsAt.getHours()).toBe(17);
    expect(c.endsAt.getTime()).toBeGreaterThan(c.startsAt.getTime());
  });
});

describe("muse.calendar.update — a provided-but-unparseable time errors, never a silent no-op success", () => {
  function harness() {
    const existing = { endsAt: new Date(2026, 0, 10, 16, 0), id: "e1", providerId: "local", startsAt: new Date(2026, 0, 10, 15, 0), title: "Standup" };
    let updateCalls = 0;
    const registry = {
      createEvent: async () => ({}),
      deleteEvent: async () => undefined,
      listEvents: async () => [existing],
      updateEvent: async () => { updateCalls += 1; return existing; }
    } as unknown as Parameters<typeof createCalendarMcpServer>[0]["registry"];
    const server = createCalendarMcpServer({ registry });
    const update = server.tools.find((t) => t.name === "update")!;
    return { update, updateCalls: () => updateCalls };
  }

  it("an unparseable startsAt returns an error and does NOT call updateEvent (no silent-drop success)", async () => {
    const h = harness();
    const result = await h.update.execute({ id: "e1", startsAt: "flurbsday" }) as Record<string, unknown>;
    expect(result.error).toContain("startsAt could not be parsed");
    expect(h.updateCalls()).toBe(0); // the move was refused, not silently dropped while reporting done
  });

  it("an unparseable endsAt returns an error and does NOT call updateEvent (no end-before-start)", async () => {
    const h = harness();
    const result = await h.update.execute({ endsAt: "flurbsday", id: "e1", startsAt: "2026-06-20T15:00:00" }) as Record<string, unknown>;
    expect(result.error).toContain("endsAt could not be parsed");
    expect(h.updateCalls()).toBe(0);
  });
});

describe("muse.calendar.add — an impossible calendar date is rejected, not rolled over", () => {
  it("rejects '2026-02-30' (would roll to Mar 2) instead of scheduling the wrong day", async () => {
    const { add, captured } = addTool();
    const result = await add.execute({ startsAt: "2026-02-30", title: "Dentist" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error"); // was: no error, event silently created on Mar 2
    expect(captured()).toBeUndefined();     // was: createEvent called with the rolled-over date
  });

  it("still accepts a real date, a full ISO timestamp, and the leap day", async () => {
    expect(await addTool().add.execute({ startsAt: "2026-05-20", title: "ok" })).not.toHaveProperty("error");
    expect(await addTool().add.execute({ startsAt: "2026-05-20T15:00:00Z", title: "ok" })).not.toHaveProperty("error");
    expect(await addTool().add.execute({ startsAt: "2028-02-29", title: "leap" })).not.toHaveProperty("error"); // 2028 is a leap year
  });
});
