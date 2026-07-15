import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readReminders } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("POST /api/reminders concurrency", () => {
  it("preserves every concurrent create through the locked store mutation", async () => {
    const remindersFile = join(mkdtempSync(join(tmpdir(), "muse-reminders-concurrent-")), "reminders.json");
    const server = buildServer({ logger: false, remindersFile });

    const responses = await Promise.all(Array.from({ length: 20 }, (_unused, index) =>
      server.inject({ method: "POST", url: "/api/reminders", payload: { text: `reminder ${index.toString()}`, dueAt: "2030-01-01T09:00:00Z" } })
    ));

    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(await readReminders(remindersFile)).toHaveLength(20);
  });
});
