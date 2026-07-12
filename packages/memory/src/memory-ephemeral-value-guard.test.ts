import { describe, expect, it } from "vitest";

import { dropEphemeralFacts, isEphemeralValue } from "./memory-ephemeral-value-guard.js";

describe("isEphemeralValue — FIX 2 ephemeral value guard", () => {
  it("flags the confirmed jiwoo case: '오늘 저녁 7시'", () => {
    expect(isEphemeralValue("오늘 저녁 7시")).toBe(true);
  });
  it.each(["오늘", "내일", "모레", "이따", "이따가", "방금", "지금", "아까"])(
    "flags relative-day marker %s",
    (marker) => {
      expect(isEphemeralValue(`${marker} 7시에 만나요`)).toBe(true);
    }
  );
  it("does NOT flag an absolute date value ('8월 5일')", () => {
    expect(isEphemeralValue("8월 5일")).toBe(false);
  });
  it("does NOT flag an absolute date with a relative-month phrase ('다음달 5일')", () => {
    expect(isEphemeralValue("다음달 5일")).toBe(false);
  });
  it("does NOT flag an ordinary non-time value", () => {
    expect(isEphemeralValue("Seoul")).toBe(false);
    expect(isEphemeralValue("라면")).toBe(false);
  });
});

describe("dropEphemeralFacts", () => {
  it("drops the ephemeral entry and keeps the durable ones", () => {
    const out = dropEphemeralFacts({
      climbing_gym_time: "오늘 저녁 7시",
      daughter_birthday: "8월 5일",
      home_city: "Seoul"
    });
    expect(out).toEqual({ daughter_birthday: "8월 5일", home_city: "Seoul" });
  });

  it("is a no-op when nothing is ephemeral", () => {
    const record = { home_city: "Seoul", pet: "dog" };
    expect(dropEphemeralFacts(record)).toEqual(record);
  });

  it("returns {} for an all-ephemeral input", () => {
    expect(dropEphemeralFacts({ meeting_time: "이따 3시" })).toEqual({});
  });

  it("returns {} for an empty record", () => {
    expect(dropEphemeralFacts({})).toEqual({});
  });
});
