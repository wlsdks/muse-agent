import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCheckinQuestion,
  readCheckins,
  runDueCheckins,
  scheduleCheckins,
  writeCheckins,
  type CheckinSendRegistry,
  type PersistedCheckin
} from "../src/commitment-checkin.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-checkin-")), "checkins.json");
}

const NOW = new Date("2026-05-01T09:00:00.000Z");

describe("buildCheckinQuestion", () => {
  it("templates a KO question for a Korean commitment, EN otherwise", () => {
    expect(buildCheckinQuestion("내일 면접 준비")).toContain("어떻게 됐어요?");
    expect(buildCheckinQuestion("finish the slides")).toBe('Following up — you mentioned you\'d "finish the slides". How did it go?');
  });
});

describe("scheduleCheckins", () => {
  it("schedules next-day-at-slot, deduped, capped", () => {
    const out = scheduleCheckins(["email Bob", "email Bob", "renew passport"], { now: NOW, userId: "stark", slotHour: 10 });
    expect(out).toHaveLength(2); // dedup "email Bob"
    expect(out[0]!.dueAtIso).toBe(new Date(2026, 4, 2, 10, 0, 0).toISOString());
    expect(out.every((c) => c.status === "scheduled")).toBe(true);
  });

  it("skips commitments already tracked and respects maxPerDay", () => {
    const existing: PersistedCheckin[] = [
      { id: "x", userId: "stark", commitment: "email Bob", question: "q", dueAtIso: "z", createdAt: NOW.toISOString(), status: "scheduled", sourceKey: "email bob" }
    ];
    const out = scheduleCheckins(["email Bob", "call Alice", "buy milk", "ship PR"], { now: NOW, userId: "stark", existing, maxPerDay: 3 });
    // "email Bob" deduped; 3 today minus 1 already scheduled today → budget 2
    expect(out.map((c) => c.commitment)).toEqual(["call Alice", "buy milk"]);
  });
});

describe("runDueCheckins", () => {
  function recordingRegistry(): { registry: CheckinSendRegistry; sent: string[] } {
    const sent: string[] = [];
    return { registry: { send: async (_p, m) => { sent.push(m.text); } }, sent };
  }

  it("delivers a due check-in and marks it fired", async () => {
    const file = tmpFile();
    await writeCheckins(file, [
      { id: "a", userId: "stark", commitment: "email Bob", question: "How did emailing Bob go?", dueAtIso: new Date("2026-05-02T10:00:00Z").toISOString(), createdAt: NOW.toISOString(), status: "scheduled", sourceKey: "email bob" }
    ]);
    const { registry, sent } = recordingRegistry();
    const res = await runDueCheckins({ file, registry, providerId: "log", destination: "me", now: () => new Date("2026-05-02T10:05:00Z") });
    expect(res.delivered).toBe(1);
    expect(sent).toEqual(["How did emailing Bob go?"]);
    expect((await readCheckins(file))[0]!.status).toBe("fired");
  });

  it("does NOT deliver a check-in that isn't due yet", async () => {
    const file = tmpFile();
    await writeCheckins(file, [
      { id: "a", userId: "stark", commitment: "x", question: "q", dueAtIso: new Date("2026-05-09T10:00:00Z").toISOString(), createdAt: NOW.toISOString(), status: "scheduled", sourceKey: "x" }
    ]);
    const { registry, sent } = recordingRegistry();
    const res = await runDueCheckins({ file, registry, providerId: "log", destination: "me", now: () => new Date("2026-05-02T10:00:00Z") });
    expect(res.delivered).toBe(0);
    expect(sent).toEqual([]);
  });

  it("holds the whole tick during quiet hours (DND)", async () => {
    const file = tmpFile();
    await writeCheckins(file, [
      { id: "a", userId: "stark", commitment: "x", question: "q", dueAtIso: new Date("2026-05-02T10:00:00Z").toISOString(), createdAt: NOW.toISOString(), status: "scheduled", sourceKey: "x" }
    ]);
    const { registry, sent } = recordingRegistry();
    const res = await runDueCheckins({
      file, registry, providerId: "log", destination: "me",
      now: () => new Date(2026, 4, 2, 23, 0, 0), // 23:00 local
      quietHours: { startHour: 22, endHour: 7 }
    });
    expect(res.delivered).toBe(0);
    expect(sent).toEqual([]);
    expect((await readCheckins(file))[0]!.status).toBe("scheduled"); // not consumed
  });
});
