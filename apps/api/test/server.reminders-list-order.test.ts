/**
 * `GET /api/reminders` must order by the real due *instant*, not a
 * raw ISO string compare — the REST sibling of the MCP-loopback
 * fix (goal 291). A free-form `dueAt` (hand-edited reminders.json
 * / import / snooze) with mixed precision or a timezone offset
 * must not surface the wrong reminder as most imminent.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReminders } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("GET /api/reminders ordering", () => {
  it("orders soonest-due-first by instant across mixed ISO forms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-list-order-"));
    const remindersFile = join(dir, "reminders.json");
    await writeReminders(remindersFile, [
      // 2026-05-20 — clearly latest.
      { createdAt: "2026-05-13T01:00:00.000Z", dueAt: "2026-05-20T00:00:00Z", id: "late", status: "pending", text: "late" },
      // 09:00:00.500Z — later than offset-soonest, string-sorts BEFORE "…Z".
      { createdAt: "2026-05-13T02:00:00.000Z", dueAt: "2026-05-14T09:00:00.500Z", id: "ms-mid", status: "pending", text: "mid" },
      // 18:00+09:00 == 09:00:00.000Z — the earliest instant, string-sorts in the middle.
      { createdAt: "2026-05-13T03:00:00.000Z", dueAt: "2026-05-14T18:00:00+09:00", id: "offset-soonest", status: "pending", text: "soon" }
    ]);

    const server = buildServer({ logger: false, remindersFile });
    const response = await server.inject({ method: "GET", url: "/api/reminders" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { reminders: ReadonlyArray<{ id: string }> };
    // Instant order: offset-soonest (09:00:00.000) < ms-mid
    // (09:00:00.500) < late. Pre-fix localeCompare gave
    // ["ms-mid","offset-soonest","late"] — wrong most-imminent.
    expect(body.reminders.map((r) => r.id)).toEqual(["offset-soonest", "ms-mid", "late"]);
  });
});
