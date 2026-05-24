import { describe, expect, it } from "vitest";

import { imminentItems, jobCompletionItems, jobDoneNoticeText, pickUnseen, proactiveNoticeText, relativeWhen } from "./chat-proactive.js";

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
