import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendInterruptionDelivery, readDigestQueue, readInterruptionLedger } from "@muse/stores";

import {
  appendCheckins,
  buildCheckinQuestion,
  cancelCheckin,
  followupDayOffset,
  readCheckins,
  runDueCheckins,
  scheduleCheckins,
  selectDueCheckins,
  snoozeCheckin,
  writeCheckins,
  type CheckinSendRegistry,
  type PersistedCheckin
} from "../src/commitment-checkin.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-checkin-")), "checkins.json");
}

function tmpBudgetDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-checkin-budget-"));
}

const NOW = new Date("2026-05-01T09:00:00.000Z");

describe("buildCheckinQuestion", () => {
  it("templates a KO question for a Korean commitment, EN otherwise", () => {
    expect(buildCheckinQuestion("내일 면접 준비")).toContain("어떻게 됐어요?");
    expect(buildCheckinQuestion("finish the slides")).toBe('Following up — you mentioned you\'d "finish the slides". How did it go?');
  });
});

describe("followupDayOffset", () => {
  it("reads the timeframe the user voiced (EN + KO), defaulting to next-day", () => {
    expect(followupDayOffset("renew my passport next week")).toBe(8);
    expect(followupDayOffset("여권 갱신 다음 주에 해야 해")).toBe(8);
    expect(followupDayOffset("submit the tax forms this week")).toBe(5);
    expect(followupDayOffset("이번 주에 보고서 내야 해")).toBe(5);
    expect(followupDayOffset("finish the deck by friday")).toBe(5);
    expect(followupDayOffset("call the dentist tomorrow")).toBe(2);
    expect(followupDayOffset("내일 면접 준비")).toBe(2);
    expect(followupDayOffset("meet the team next thursday")).toBe(2);
    // no timeframe, or a same-day one → next day.
    expect(followupDayOffset("email the team later today")).toBe(1);
    expect(followupDayOffset("review the PR")).toBe(1);
  });
});

describe("cancelCheckin", () => {
  const mk = (id: string, status: PersistedCheckin["status"]): PersistedCheckin => ({
    id, userId: "stark", commitment: id, question: `q ${id}`, dueAtIso: "2026-05-02T10:00:00.000Z",
    createdAt: NOW.toISOString(), status, sourceKey: id
  });

  it("cancels a scheduled check-in by exact id and marks it cancelled", () => {
    const list = [mk("chk_a1", "scheduled"), mk("chk_b2", "scheduled")];
    const res = cancelCheckin(list, "chk_a1");
    expect(res.cancelled?.id).toBe("chk_a1");
    expect(res.checkins.find((c) => c.id === "chk_a1")?.status).toBe("cancelled");
    expect(res.checkins.find((c) => c.id === "chk_b2")?.status).toBe("scheduled"); // untouched
  });

  it("cancels by a UNIQUE id prefix (the list shows the full id; a prefix is the convenience)", () => {
    const res = cancelCheckin([mk("chk_abc", "scheduled"), mk("chk_xyz", "scheduled")], "chk_ab");
    expect(res.cancelled?.id).toBe("chk_abc");
  });

  it("refuses an AMBIGUOUS prefix rather than cancelling the wrong one", () => {
    const res = cancelCheckin([mk("chk_a1", "scheduled"), mk("chk_a2", "scheduled")], "chk_a");
    expect(res.cancelled).toBeUndefined();
    expect(res.reason).toBe("ambiguous");
    expect(res.matches).toBe(2);
    expect(res.checkins.every((c) => c.status === "scheduled")).toBe(true); // nothing changed
  });

  it("reports not-found / already-fired / already-cancelled without mutating", () => {
    const list = [mk("chk_f", "fired"), mk("chk_c", "cancelled")];
    expect(cancelCheckin(list, "chk_missing").reason).toBe("not-found");
    expect(cancelCheckin(list, "chk_f").reason).toBe("already-fired");
    expect(cancelCheckin(list, "chk_c").reason).toBe("already-cancelled");
    expect(cancelCheckin([], "").reason).toBe("not-found");
  });
});

describe("selectDueCheckins", () => {
  const at = (iso: string, id: string, status: PersistedCheckin["status"]): PersistedCheckin => ({
    id, userId: "stark", commitment: id, question: `q ${id}`, dueAtIso: iso,
    createdAt: NOW.toISOString(), status, sourceKey: id
  });
  const nowMs = Date.parse("2026-05-05T12:00:00.000Z");

  it("returns only SCHEDULED check-ins whose due moment has passed, soonest-first", () => {
    const list = [
      at("2026-05-05T08:00:00.000Z", "due_b", "scheduled"),
      at("2026-05-04T08:00:00.000Z", "due_a", "scheduled"), // earlier → first
      at("2026-05-06T08:00:00.000Z", "future", "scheduled"), // not yet due
      at("2026-05-01T08:00:00.000Z", "fired", "fired"), // due but already fired
      at("2026-05-01T08:00:00.000Z", "cancelled", "cancelled") // due but cancelled
    ];
    expect(selectDueCheckins(list, nowMs).map((c) => c.id)).toEqual(["due_a", "due_b"]);
  });

  it("caps the result and treats a non-finite max as the default", () => {
    const many = Array.from({ length: 8 }, (_, i) => at(`2026-05-0${(i % 5) + 1}T08:00:00.000Z`, `c${i.toString()}`, "scheduled"));
    expect(selectDueCheckins(many, nowMs, 3)).toHaveLength(3);
    expect(selectDueCheckins([], nowMs)).toEqual([]);
  });
});

describe("snoozeCheckin", () => {
  const mk = (id: string, status: PersistedCheckin["status"]): PersistedCheckin => ({
    id, userId: "stark", commitment: id, question: `q ${id}`, dueAtIso: "2026-05-02T10:00:00.000Z",
    createdAt: NOW.toISOString(), status, sourceKey: id
  });
  const LATER = "2026-05-10T10:00:00.000Z";

  it("bumps a scheduled check-in's due time, keeping it scheduled, leaving siblings untouched", () => {
    const list = [mk("chk_a", "scheduled"), mk("chk_b", "scheduled")];
    const res = snoozeCheckin(list, "chk_a", LATER);
    expect(res.snoozed?.id).toBe("chk_a");
    expect(res.snoozed?.dueAtIso).toBe(LATER);
    const a = res.checkins.find((c) => c.id === "chk_a")!;
    expect(a.dueAtIso).toBe(LATER);
    expect(a.status).toBe("scheduled"); // still scheduled, just later
    expect(res.checkins.find((c) => c.id === "chk_b")?.dueAtIso).toBe("2026-05-02T10:00:00.000Z"); // untouched
  });

  it("resolves a unique prefix and refuses an ambiguous one without mutating", () => {
    expect(snoozeCheckin([mk("chk_abc", "scheduled")], "chk_ab", LATER).snoozed?.id).toBe("chk_abc");
    const amb = snoozeCheckin([mk("chk_a1", "scheduled"), mk("chk_a2", "scheduled")], "chk_a", LATER);
    expect(amb.snoozed).toBeUndefined();
    expect(amb.reason).toBe("ambiguous");
    expect(amb.checkins.every((c) => c.dueAtIso === "2026-05-02T10:00:00.000Z")).toBe(true);
  });

  it("reports not-found / already-fired / already-cancelled without mutating", () => {
    const list = [mk("chk_f", "fired"), mk("chk_c", "cancelled")];
    expect(snoozeCheckin(list, "chk_missing", LATER).reason).toBe("not-found");
    expect(snoozeCheckin(list, "chk_f", LATER).reason).toBe("already-fired");
    expect(snoozeCheckin(list, "chk_c", LATER).reason).toBe("already-cancelled");
  });
});

describe("scheduleCheckins", () => {
  it("schedules next-day-at-slot, deduped, capped", () => {
    const out = scheduleCheckins(["email Bob", "email Bob", "renew passport"], { now: NOW, userId: "stark", slotHour: 10 });
    expect(out).toHaveLength(2); // dedup "email Bob"
    expect(out[0]!.dueAtIso).toBe(new Date(2026, 4, 2, 10, 0, 0).toISOString());
    expect(out.every((c) => c.status === "scheduled")).toBe(true);
  });

  it("fires the check-in AFTER the commitment's stated timeframe, not always next-day", () => {
    const out = scheduleCheckins(
      ["email the team later today", "submit the tax forms this week", "renew my passport next week"],
      { now: NOW, userId: "stark", slotHour: 10, maxPerDay: 5 }
    );
    // "later today" → next day (+1); "this week" → +5; "next week" → +8.
    expect(out[0]!.dueAtIso).toBe(new Date(2026, 4, 2, 10, 0, 0).toISOString());
    expect(out[1]!.dueAtIso).toBe(new Date(2026, 4, 6, 10, 0, 0).toISOString());
    expect(out[2]!.dueAtIso).toBe(new Date(2026, 4, 9, 10, 0, 0).toISOString());
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

  describe("interruption budget (opt-in)", () => {
    const mkDue = (id: string): PersistedCheckin => ({
      commitment: id, createdAt: NOW.toISOString(), dueAtIso: new Date("2026-05-02T10:00:00Z").toISOString(),
      id, question: `q-${id}`, sourceKey: id, status: "scheduled", userId: "stark"
    });

    it("cap reached: registry.send is never called, the question lands in the digest, and the check-in is still marked fired", async () => {
      const file = tmpFile();
      await writeCheckins(file, [mkDue("a")]);
      const budgetDir = tmpBudgetDir();
      const ledgerFile = join(budgetDir, "ledger.json");
      const digestFile = join(budgetDir, "digest.json");
      const now = new Date("2026-05-02T10:05:00Z");
      await appendInterruptionDelivery(ledgerFile, { at: now, source: "commitment-checkin" });

      const { registry, sent } = recordingRegistry();
      const res = await runDueCheckins({
        destination: "me",
        file,
        interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 1, ledgerFile },
        now: () => now,
        providerId: "log",
        registry
      });
      expect(res.delivered).toBe(0);
      expect(sent).toEqual([]);
      expect((await readCheckins(file))[0]!.status).toBe("fired"); // sidecar marks fired regardless
      const queued = await readDigestQueue(digestFile);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ source: "commitment-checkin", sourceId: "a", text: "q-a" });
    });

    it("cap not reached: delivers exactly as without a budget, and records the ledger", async () => {
      const file = tmpFile();
      await writeCheckins(file, [mkDue("a")]);
      const budgetDir = tmpBudgetDir();
      const ledgerFile = join(budgetDir, "ledger.json");
      const digestFile = join(budgetDir, "digest.json");
      const now = new Date("2026-05-02T10:05:00Z");

      const { registry, sent } = recordingRegistry();
      const res = await runDueCheckins({
        destination: "me",
        file,
        interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, ledgerFile },
        now: () => now,
        providerId: "log",
        registry
      });
      expect(res.delivered).toBe(1);
      expect(sent).toEqual(["q-a"]);
      expect((await readCheckins(file))[0]!.status).toBe("fired");
      expect(await readInterruptionLedger(ledgerFile)).toHaveLength(1);
      expect(await readDigestQueue(digestFile)).toHaveLength(0);
    });

    it("interruptionBudget absent: behavior is byte-identical to the pre-budget path", async () => {
      const file = tmpFile();
      await writeCheckins(file, [mkDue("a")]);
      const { registry, sent } = recordingRegistry();
      const res = await runDueCheckins({ destination: "me", file, now: () => new Date("2026-05-02T10:05:00Z"), providerId: "log", registry });
      expect(res.delivered).toBe(1);
      expect(sent).toEqual(["q-a"]);
    });

    it("a corrupt ledger file fails OPEN — the check-in still delivers", async () => {
      const file = tmpFile();
      await writeCheckins(file, [mkDue("a")]);
      const budgetDir = tmpBudgetDir();
      const ledgerFile = join(budgetDir, "ledger.json");
      const digestFile = join(budgetDir, "digest.json");
      writeFileSync(ledgerFile, "{ not valid json", "utf8");

      const { registry, sent } = recordingRegistry();
      const res = await runDueCheckins({
        destination: "me",
        file,
        interruptionBudget: { dailyCap: 1, digestFile, hourlyCap: 1, ledgerFile },
        now: () => new Date("2026-05-02T10:05:00Z"),
        providerId: "log",
        registry
      });
      expect(res.delivered).toBe(1);
      expect(sent).toEqual(["q-a"]);
    });
  });
});

describe("commitment check-ins — concurrent mutations don't lose updates", () => {
  const mk = (id: string, dueAtIso: string): PersistedCheckin =>
    ({ commitment: id, createdAt: NOW.toISOString(), dueAtIso, id, question: `q-${id}`, sourceKey: id, status: "scheduled", userId: "stark" });

  it("a check-in appended mid-send (chat hook) survives the fired-status write — no stale-snapshot clobber", async () => {
    const file = tmpFile();
    await writeCheckins(file, [mk("a", new Date("2026-05-02T10:00:00Z").toISOString())]);
    const extra = mk("b", new Date("2026-05-09T10:00:00Z").toISOString()); // appended during the send window, not yet due
    // The send hook appends a NEW check-in mid-send (the multi-second delivery window).
    const registry: CheckinSendRegistry = { send: async () => { await appendCheckins(file, [extra]); } };
    const res = await runDueCheckins({ destination: "me", file, now: () => new Date("2026-05-02T10:05:00Z"), providerId: "log", registry });
    expect(res.delivered).toBe(1);
    const persisted = await readCheckins(file);
    expect(persisted.find((c) => c.id === "a")?.status).toBe("fired"); // the fired one IS marked
    expect(persisted.find((c) => c.id === "b")).toBeDefined(); // the mid-send append was NOT clobbered by the stale write
  });

  it("two concurrent appendCheckins both persist (no lost-update)", async () => {
    const file = tmpFile();
    await writeCheckins(file, []);
    await Promise.all([
      appendCheckins(file, [mk("x", new Date("2026-05-09T10:00:00Z").toISOString())]),
      appendCheckins(file, [mk("y", new Date("2026-05-09T10:00:00Z").toISOString())])
    ]);
    expect((await readCheckins(file)).map((c) => c.id).sort()).toEqual(["x", "y"]);
  });
});
