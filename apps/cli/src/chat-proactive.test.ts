import { describe, expect, it } from "vitest";

import { imminentItems, pickUnseen, proactiveNoticeText, relativeWhen } from "./chat-proactive.js";

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
