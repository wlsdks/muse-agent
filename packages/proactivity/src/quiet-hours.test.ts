import { describe, expect, it } from "vitest";

import {
  gateProactiveNoticeSink,
  isQuietHour,
  parseQuietHours,
  minutesUntil,
  resolveEffectiveQuietHours,
  resolveQuietHoursOption
} from "./quiet-hours.js";

import type { ProactiveNoticeSink } from "./proactive-notice-loop.js";

describe("parseQuietHours", () => {
  it("parses bare hour and HH:MM forms", () => {
    expect(parseQuietHours("22-7")).toEqual({ endHour: 7, startHour: 22 });
    expect(parseQuietHours("22:00-07:00")).toEqual({ endHour: 7, startHour: 22 });
  });

  it("rejects malformed / out-of-range / empty-window input", () => {
    expect(parseQuietHours(undefined)).toBeUndefined();
    expect(parseQuietHours("")).toBeUndefined();
    expect(parseQuietHours("garbage")).toBeUndefined();
    expect(parseQuietHours("24-7")).toBeUndefined();
    expect(parseQuietHours("22-22")).toBeUndefined();
    expect(parseQuietHours("22:60-7:00")).toBeUndefined();
  });
});

describe("isQuietHour", () => {
  it("handles a non-wrapping window", () => {
    const range = { endHour: 17, startHour: 9 };
    expect(isQuietHour(9, range)).toBe(true);
    expect(isQuietHour(16, range)).toBe(true);
    expect(isQuietHour(17, range)).toBe(false); // exclusive end
    expect(isQuietHour(8, range)).toBe(false);
  });

  it("handles a midnight-wrapping window", () => {
    const range = { endHour: 7, startHour: 22 };
    expect(isQuietHour(23, range)).toBe(true);
    expect(isQuietHour(0, range)).toBe(true);
    expect(isQuietHour(6, range)).toBe(true);
    expect(isQuietHour(7, range)).toBe(false);
    expect(isQuietHour(21, range)).toBe(false);
  });
});

describe("resolveQuietHoursOption", () => {
  it("passes a static range through unchanged", () => {
    const range = { endHour: 7, startHour: 22 };
    expect(resolveQuietHoursOption(range)).toBe(range);
  });

  it("calls a resolver function FRESH every time — the live-per-tick seam", () => {
    let calls = 0;
    const resolver = () => {
      calls += 1;
      return calls === 1 ? { endHour: 7, startHour: 22 } : undefined;
    };
    expect(resolveQuietHoursOption(resolver)).toEqual({ endHour: 7, startHour: 22 });
    expect(resolveQuietHoursOption(resolver)).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("undefined stays undefined", () => {
    expect(resolveQuietHoursOption(undefined)).toBeUndefined();
  });
});

describe("resolveEffectiveQuietHours — the ONE precedence resolver both API tick-daemons and the CLI daemon consume", () => {
  it("precedence: per-loop env > base env > persisted", () => {
    expect(resolveEffectiveQuietHours({ baseEnvRaw: "1-2", perLoopEnvRaw: "3-4", persisted: { enabled: true, range: "5-6" } }))
      .toEqual({ endHour: 4, startHour: 3 });
    expect(resolveEffectiveQuietHours({ baseEnvRaw: "1-2", persisted: { enabled: true, range: "5-6" } }))
      .toEqual({ endHour: 2, startHour: 1 });
    expect(resolveEffectiveQuietHours({ persisted: { enabled: true, range: "5-6" } }))
      .toEqual({ endHour: 6, startHour: 5 });
  });

  it("a disabled persisted setting is ignored even with a valid range", () => {
    expect(resolveEffectiveQuietHours({ persisted: { enabled: false, range: "5-6" } })).toBeUndefined();
  });

  it("an invalid persisted range fails soft to undefined and reports via onInvalidPersisted", () => {
    const seen: string[] = [];
    const result = resolveEffectiveQuietHours({
      onInvalidPersisted: (raw) => seen.push(raw),
      persisted: { enabled: true, range: "not-a-range" }
    });
    expect(result).toBeUndefined();
    expect(seen).toEqual(["not-a-range"]);
  });

  it("nothing set anywhere resolves to undefined without calling onInvalidPersisted", () => {
    const seen: string[] = [];
    expect(resolveEffectiveQuietHours({ onInvalidPersisted: (raw) => seen.push(raw) })).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("gateProactiveNoticeSink — now accepts a live resolver, not just a static range", () => {
  function makeSink(delivered: string[]): ProactiveNoticeSink {
    return { deliver: async (notice) => { delivered.push(notice.title); } };
  }

  it("re-reads a resolver function on EVERY delivery, so a change takes effect on the next call with no re-wrap", async () => {
    const delivered: string[] = [];
    let quiet = true;
    const gated = gateProactiveNoticeSink(makeSink(delivered), {
      quietHours: () => (quiet ? { endHour: 7, startHour: 22 } : undefined),
      now: () => new Date(2026, 0, 1, 23, 0, 0)
    });
    await gated.deliver({ kind: "k", text: "t", title: "held" });
    expect(delivered).toEqual([]); // suppressed while quiet
    quiet = false;
    await gated.deliver({ kind: "k", text: "t", title: "delivered" });
    expect(delivered).toEqual(["delivered"]); // the SAME wrapped sink picks up the change
  });

  it("no quietHours option at all → the original sink, unwrapped", () => {
    const delivered: string[] = [];
    const sink = makeSink(delivered);
    expect(gateProactiveNoticeSink(sink, {})).toBe(sink);
  });
});

describe("minutesUntil", () => {
  it("floors fractional minutes so 90 seconds is still 1 minute, not 2", () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const target = new Date(2026, 0, 1, 12, 1, 30);
    expect(minutesUntil(target, now)).toBe(1);
  });
});
