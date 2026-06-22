/**
 * Coverage for `GET /api/reminders/history`. The route
 * is only registered when `reminderHistoryFile` is threaded through
 * ServerOptions — without it, 404. With it, the route serves the
 * daemon-appended entries newest-first.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendReminderHistory } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("GET /api/reminders/history", () => {
  it("404s when no reminderHistoryFile is wired (default boot)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-hist-route-"));
    const server = buildServer({
      logger: false,
      remindersFile: join(dir, "reminders.json")
    });
    const response = await server.inject({ method: "GET", url: "/api/reminders/history" });
    expect(response.statusCode).toBe(404);
  });

  it("returns persisted entries newest-first with optional `limit`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-hist-route-"));
    const historyFile = join(dir, "history.json");
    await appendReminderHistory(historyFile, {
      destination: "@me",
      firedAtIso: "2026-05-11T08:00:00.000Z",
      providerId: "telegram",
      reminderId: "rem_1",
      status: "delivered",
      text: "first"
    });
    await appendReminderHistory(historyFile, {
      destination: "C123",
      error: "channel_not_found",
      firedAtIso: "2026-05-11T09:00:00.000Z",
      providerId: "slack",
      reminderId: "rem_2",
      status: "failed",
      text: "second"
    });
    const server = buildServer({
      logger: false,
      reminderHistoryFile: historyFile,
      remindersFile: join(dir, "reminders.json")
    });

    const all = await server.inject({ method: "GET", url: "/api/reminders/history" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({
      entries: [
        { reminderId: "rem_2", status: "failed", error: "channel_not_found" },
        { reminderId: "rem_1", status: "delivered" }
      ],
      total: 2
    });

    const capped = await server.inject({ method: "GET", url: "/api/reminders/history?limit=1" });
    expect(capped.statusCode).toBe(200);
    const body = capped.json() as { entries: Array<{ reminderId: string }>; total: number };
    expect(body.entries.map((e) => e.reminderId)).toEqual(["rem_2"]);
    expect(body.total).toBe(1);
  });
});
