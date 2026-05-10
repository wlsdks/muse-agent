import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CalendarProviderRegistry, LocalCalendarProvider } from "@muse/calendar";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: GET /api/today", () => {
  it("returns the consolidated briefing across tasks / calendar / notes", async () => {
    const notesDir = mkdtempSync(join(tmpdir(), "muse-today-notes-"));
    const tasksDir = mkdtempSync(join(tmpdir(), "muse-today-tasks-"));
    const tasksFile = join(tasksDir, "tasks.json");

    writeFileSync(tasksFile, JSON.stringify({
      tasks: [
        { createdAt: "2026-05-09T10:00:00Z", id: "t-old", status: "done", title: "already done" },
        { createdAt: "2026-05-10T08:00:00Z", id: "t-new", status: "open", title: "fresh todo" },
        { createdAt: "2026-05-09T12:00:00Z", id: "t-mid", status: "open", title: "older todo" }
      ]
    }), "utf8");

    writeFileSync(join(notesDir, "diary.md"), "alpha", "utf8");
    writeFileSync(join(notesDir, "shopping.md"), "beta", "utf8");

    const calendar = new CalendarProviderRegistry([
      new LocalCalendarProvider({ file: join(tasksDir, "calendar.json"), idFactory: counter() })
    ]);
    const event = await calendar.createEvent(undefined, {
      endsAt: new Date(Date.now() + 60 * 60_000),
      startsAt: new Date(Date.now() + 30 * 60_000),
      title: "Standup"
    });

    const server = buildServer({ calendar, logger: false, notesDir, tasksFile });

    const reply = await server.inject({ method: "GET", url: "/api/today?lookaheadHours=2" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as {
      events: { id: string; title: string }[];
      generatedAt: string;
      lookaheadHours: number;
      notes: string[];
      tasks: { id: string; status: string; title: string }[];
    };

    expect(body.lookaheadHours).toBe(2);
    expect(typeof body.generatedAt).toBe("string");
    expect(body.tasks.map((task) => task.id)).toEqual(["t-new", "t-mid"]);
    expect(body.events.some((entry) => entry.id === event.id)).toBe(true);
    expect(body.notes).toEqual(expect.arrayContaining(["diary.md", "shopping.md"]));
  });

  it("clamps lookaheadHours to the [1, 168] range", async () => {
    const server = buildServer({ logger: false });

    const tooSmall = await server.inject({ method: "GET", url: "/api/today?lookaheadHours=0" });
    expect(tooSmall.statusCode).toBe(200);
    expect(tooSmall.json()).toMatchObject({ lookaheadHours: 24 });

    const tooBig = await server.inject({ method: "GET", url: "/api/today?lookaheadHours=99999" });
    expect(tooBig.statusCode).toBe(200);
    expect(tooBig.json()).toMatchObject({ lookaheadHours: 168 });
  });

  it("returns undefined sections when nothing is configured", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/today" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as Record<string, unknown>;
    expect(body.tasks).toBeUndefined();
    expect(body.events).toBeUndefined();
    expect(body.notes).toBeUndefined();
    expect(body.lookaheadHours).toBe(24);
  });
});

function counter() {
  let n = 0;
  return () => `evt-${++n}`;
}
