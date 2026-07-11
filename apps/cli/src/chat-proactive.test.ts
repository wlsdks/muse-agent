import { describe, expect, it } from "vitest";

import { calendarEventItems, checkinItems, dueTaskItems, groupProactiveNotice, imminentItems, jobCompletionItems, jobDoneNoticeText, orchestrationCompletionItems, orchestrationDoneNoticeText, patternSuggestionItems, pickUnseen, proactiveNoticeText, relativeWhen } from "./chat-proactive.js";

const now = Date.UTC(2026, 4, 24, 12, 0, 0);
const iso = (minFromNow: number): string => new Date(now + minFromNow * 60_000).toISOString();

describe("imminentItems", () => {
  it("keeps items due within the lead window (incl. a short grace), drops far/undated", () => {
    const items = [
      { dueAt: iso(30), id: "soon", text: "곧" }, // in 30m → in
      { dueAt: iso(-1), id: "justpast", text: "방금" }, // 1m ago, within grace → in
      { dueAt: iso(-30), id: "old", text: "오래됨" }, // 30m ago → out
      { dueAt: iso(600), id: "far", text: "먼미래" }, // 10h → out
      { id: "undated", text: "무날짜" } // → out
    ];
    const got = imminentItems(items, now, 60 * 60_000).map((i) => i.id);
    expect(got.sort()).toEqual(["justpast", "soon"]);
  });
});

describe("pickUnseen", () => {
  it("filters out already-surfaced ids", () => {
    const items = [{ id: "a", text: "x" }, { id: "b", text: "y" }];
    expect(pickUnseen(items, new Set(["a"])).map((i) => i.id)).toEqual(["b"]);
  });
});

describe("relativeWhen", () => {
  it("phrases minutes / hours / now / past", () => {
    expect(relativeWhen(iso(30), now)).toBe("in 30m");
    expect(relativeWhen(iso(120), now)).toBe("in 2h");
    expect(relativeWhen(iso(0), now)).toBe("now");
    expect(relativeWhen(iso(-30), now)).toBe("overdue");
    expect(relativeWhen(undefined, now)).toBe("");
  });
});

describe("proactiveNoticeText", () => {
  it("renders a friendly first-speak line", () => {
    expect(proactiveNoticeText({ id: "1", text: "Dentist" }, "in 30m")).toBe("📌 Dentist (in 30m) — want a hand?");
    expect(proactiveNoticeText({ id: "1", text: "Dentist" }, "")).toBe("📌 Dentist — want a hand?");
  });
});

describe("jobDoneNoticeText", () => {
  it("phrases done (with result) and error distinctly", () => {
    expect(jobDoneNoticeText({ id: "j1", status: "done", prompt: "research X", finalText: "found  it" }))
      .toBe("✓ Background job done: research X — found it");
    expect(jobDoneNoticeText({ id: "j2", status: "error", prompt: "bad task" }))
      .toBe("✗ Background job failed: bad task");
  });
});

describe("jobCompletionItems", () => {
  const since = "2026-05-24T12:00:00.000Z";
  it("keeps only done/error jobs finished after `since`, pre-phrased with a job: id", () => {
    const items = jobCompletionItems([
      { id: "old", status: "done", prompt: "old", finishedAt: "2026-05-24T11:00:00.000Z" },
      { id: "fresh", status: "done", prompt: "fresh", finalText: "ok", finishedAt: "2026-05-24T12:05:00.000Z" },
      { id: "running", status: "running", prompt: "go" }
    ], since);
    expect(items.map((i) => i.id)).toEqual(["job:fresh"]);
    expect(items[0]?.text).toBe("✓ Background job done: fresh — ok");
  });
});

describe("orchestrationDoneNoticeText", () => {
  it("phrases a completed run with the sub-agent count + worker ids + a trimmed summary", () => {
    expect(orchestrationDoneNoticeText({
      finishedAt: "2026-05-24T12:05:00.000Z",
      id: "orch-1",
      status: "completed",
      subtaskCount: 2,
      summary: "  the launch plan looks solid  ",
      workerIds: ["direct", "critic"]
    })).toBe("✓ Background orchestration done (2 sub-agents: direct, critic) — the launch plan looks solid");
  });

  it("phrases a failed run distinctly, without a worker-id list", () => {
    expect(orchestrationDoneNoticeText({
      finishedAt: "2026-05-24T12:05:00.000Z",
      id: "orch-2",
      status: "failed",
      subtaskCount: 2,
      summary: "every worker threw",
      workerIds: ["direct", "critic"]
    })).toBe("✗ Background orchestration failed (2 sub-agents): every worker threw");
  });

  it("singularizes a 1-subtask run", () => {
    expect(orchestrationDoneNoticeText({
      finishedAt: "2026-05-24T12:05:00.000Z",
      id: "orch-3",
      status: "completed",
      subtaskCount: 1,
      workerIds: ["direct"]
    })).toBe("✓ Background orchestration done (1 sub-agent: direct)");
  });
});

describe("orchestrationCompletionItems", () => {
  const since = "2026-05-24T12:00:00.000Z";
  it("keeps only runs finished after `since`, ONE item per orchestration (never per worker), pre-phrased with an orchestration: id", () => {
    const items = orchestrationCompletionItems([
      { finishedAt: "2026-05-24T11:00:00.000Z", id: "old", status: "completed", subtaskCount: 2, summary: "old", workerIds: ["a", "b"] },
      { finishedAt: "2026-05-24T12:05:00.000Z", id: "fresh", status: "completed", subtaskCount: 3, summary: "done", workerIds: ["a", "b", "c"] }
    ], since);
    expect(items.map((i) => i.id)).toEqual(["orchestration:fresh"]);
    expect(items[0]?.text).toBe("✓ Background orchestration done (3 sub-agents: a, b, c) — done");
  });
});

describe("dueTaskItems", () => {
  const horizon = Date.UTC(2026, 4, 25, 12, 0, 0);
  const iso = (minFromHorizon: number): string => new Date(horizon + minFromHorizon * 60_000).toISOString();
  it("keeps open tasks due at/before the horizon, as task: proactive items", () => {
    const items = dueTaskItems([
      { id: "t1", title: "pay rent", status: "open", dueAt: iso(-30) },
      { id: "t2", title: "future", status: "open", dueAt: iso(120) },
      { id: "t3", title: "done one", status: "done", dueAt: iso(-10) },
      { id: "t4", title: "no date", status: "open" }
    ], horizon);
    expect(items.map((i) => i.id)).toEqual(["task:t1"]);
    expect(items[0]?.text).toBe("Task due: pay rent");
    expect(items[0]?.dueAt).toBe(iso(-30));
  });
});

describe("calendarEventItems", () => {
  const horizon = Date.UTC(2026, 4, 25, 12, 0, 0);
  const iso = (minFromHorizon: number): string => new Date(horizon + minFromHorizon * 60_000).toISOString();
  it("keeps events starting at/before the horizon, as event: proactive items", () => {
    const items = calendarEventItems([
      { id: "e1", title: "Standup", startsAtIso: iso(-15) },
      { id: "e2", title: "Later sync", startsAtIso: iso(120) },
      { id: "e3", title: "bad date", startsAtIso: "not-a-date" }
    ], horizon);
    expect(items.map((i) => i.id)).toEqual(["event:e1"]);
    expect(items[0]?.text).toBe("Calendar: Standup");
    expect(items[0]?.dueAt).toBe(iso(-15));
  });
  it("flows through imminentItems + groupProactiveNotice as one notice with a relative time", () => {
    const items = calendarEventItems([{ id: "e1", title: "Standup", startsAtIso: iso(15) }], horizon + 30 * 60_000);
    const grouped = groupProactiveNotice(items, horizon);
    expect(grouped).toBe("📌 Calendar: Standup (in 15m) — want a hand?");
  });
});

describe("proactive surface composition — the speaks-first tick pipeline (audit)", () => {
  const now = Date.UTC(2026, 4, 25, 12, 0, 0);
  const lead = 30 * 60_000;
  const at = (m: number): string => new Date(now + m * 60_000).toISOString();
  it("reminders + followups + tasks + calendar fold into ONE grouped notice, and the seen-set dedups a second tick", () => {
    const all = [
      { id: "r1", text: "Call mom", dueAt: at(10) },
      { id: "f1", text: "Reply to Sam", dueAt: at(20) },
      ...dueTaskItems([{ id: "t1", title: "pay rent", status: "open", dueAt: at(5) }], now + lead),
      ...calendarEventItems([{ id: "e1", title: "Standup", startsAtIso: at(15) }], now + lead)
    ];
    const seen = new Set<string>();
    const unseen = pickUnseen(imminentItems(all, now, lead), seen);
    expect(unseen).toHaveLength(4);
    const grouped = groupProactiveNotice(unseen, now);
    expect(grouped).toContain("4 things need you");
    for (const needle of ["Call mom", "Reply to Sam", "Task due: pay rent", "Calendar: Standup"]) {
      expect(grouped).toContain(needle);
    }
    // Second tick after marking them seen → nothing re-surfaces (no spam).
    for (const item of unseen) seen.add(item.id);
    expect(pickUnseen(imminentItems(all, now, lead), seen)).toHaveLength(0);
  });
  it("out-of-window items are withheld until they enter the lead window", () => {
    const all = [
      { id: "soon", text: "Soon", dueAt: at(10) },
      { id: "later", text: "Later", dueAt: at(180) }
    ];
    const unseen = pickUnseen(imminentItems(all, now, lead), new Set());
    expect(unseen.map((i) => i.id)).toEqual(["soon"]);
  });
  it("finished jobs surface on their OWN pre-phrased line, not folded into the group", () => {
    const jobs = jobCompletionItems([{ id: "j1", status: "done", prompt: "build report", finishedAt: at(-1) }], at(-100));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.text).toContain("Background job done");
    expect(jobs[0]?.id).toBe("job:j1");
  });
});

describe("groupProactiveNotice", () => {
  const now = Date.UTC(2026, 4, 25, 12, 0, 0);
  const iso = (m: number): string => new Date(now + m * 60_000).toISOString();
  it("empty → '', one item → the single line", () => {
    expect(groupProactiveNotice([], now)).toBe("");
    expect(groupProactiveNotice([{ id: "1", text: "Dentist", dueAt: iso(30) }], now)).toBe("📌 Dentist (in 30m) — want a hand?");
  });
  it("≥2 items → one grouped line, not a wall", () => {
    const out = groupProactiveNotice([
      { id: "1", text: "Dentist", dueAt: iso(30) },
      { id: "2", text: "Pay rent", dueAt: iso(-1) },
      { id: "3", text: "Standup" }
    ], now);
    expect(out).toBe("📌 3 things need you: Dentist (in 30m); Pay rent (now); Standup — want a hand?");
  });
});

describe("checkinItems", () => {
  it("surfaces only scheduled, already-due check-ins (verbatim question, namespaced id)", () => {
    const items = checkinItems([
      { id: "a", question: "Following up — you mentioned you'd \"email Bob\". How did it go?", dueAtIso: iso(-60), status: "scheduled" },
      { id: "b", question: "future one", dueAtIso: iso(60), status: "scheduled" }, // not due yet
      { id: "c", question: "already delivered", dueAtIso: iso(-120), status: "fired" }, // daemon owns it
      { id: "d", question: "bad date", dueAtIso: "not-a-date", status: "scheduled" }
    ], now);
    expect(items).toEqual([
      { dueAt: iso(-60), id: "checkin:a", text: "📌 Following up — you mentioned you'd \"email Bob\". How did it go?" }
    ]);
  });
});

describe("patternSuggestionItems", () => {
  it("maps fireable matches to undated, namespaced nudges (verbatim suggestion)", () => {
    expect(patternSuggestionItems([
      { id: "p1", suggestion: "월요일마다 보고서 만드시던데, 지금 초안 잡아둘까요?" }
    ])).toEqual([
      { id: "pattern:p1", text: "💡 월요일마다 보고서 만드시던데, 지금 초안 잡아둘까요?" }
    ]);
    expect(patternSuggestionItems([])).toEqual([]);
  });
});
