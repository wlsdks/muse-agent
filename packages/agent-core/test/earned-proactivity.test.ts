import { describe, expect, it } from "vitest";

import { selectEarnedThemes, type ThemeSignal } from "../src/earned-proactivity.js";

const NOW = Date.UTC(2026, 5, 1);
const daysAgo = (d: number): number => NOW - d * 24 * 60 * 60_000;
const daysAhead = (d: number): number => NOW + d * 24 * 60 * 60_000;

describe("selectEarnedThemes — C1 feed-forward persistence gate (earned proactivity)", () => {
  it("fires a theme that PERSISTED across sources, over time, and is still active", () => {
    const earned = selectEarnedThemes(
      [{
        theme: "house move",
        occurrences: [
          { source: "notes/move.md", atMs: daysAgo(6) },
          { source: "calendar", atMs: daysAgo(4) },
          { source: "query", atMs: daysAgo(1) }
        ]
      }],
      { nowMs: NOW }
    );
    expect(earned.map((t) => t.theme)).toEqual(["house move"]);
    expect(earned[0]!.distinctSources).toBe(3);
  });

  it("FILTERS a single fleeting mention (the noise the FFL exists to reject)", () => {
    expect(selectEarnedThemes([{ theme: "random", occurrences: [{ source: "query", atMs: daysAgo(1) }] }], { nowMs: NOW })).toEqual([]);
  });

  it("FILTERS a theme seen many times but in only ONE source (no cross-source corroboration)", () => {
    const oneSource: ThemeSignal = {
      theme: "single-note-topic",
      occurrences: [daysAgo(6), daysAgo(4), daysAgo(2)].map((atMs) => ({ atMs, source: "notes/a.md" }))
    };
    expect(selectEarnedThemes([oneSource], { nowMs: NOW })).toEqual([]);
  });

  it("FILTERS a same-day burst (3 mentions, dwell 0 — not sustained)", () => {
    const burst: ThemeSignal = {
      theme: "burst",
      occurrences: [{ source: "a", atMs: daysAgo(1) }, { source: "b", atMs: daysAgo(1) }, { source: "c", atMs: daysAgo(1) }]
    };
    expect(selectEarnedThemes([burst], { nowMs: NOW })).toEqual([]);
  });

  it("FILTERS a theme that persisted but went quiet (stale, no longer active)", () => {
    const stale: ThemeSignal = {
      theme: "old-project",
      occurrences: [{ source: "a", atMs: daysAgo(60) }, { source: "b", atMs: daysAgo(50) }, { source: "c", atMs: daysAgo(40) }]
    };
    expect(selectEarnedThemes([stale], { nowMs: NOW })).toEqual([]); // last 40d ago > activeWithinDays 14
  });

  it("does NOT let future occurrences resurrect a stale theme (persistence is past-only)", () => {
    // persisted in the past but last REAL mention 40d ago (stale) + an upcoming
    // calendar event. The future event must not make it read as "just seen".
    const staleWithFuture: ThemeSignal = {
      theme: "old-project",
      occurrences: [
        { source: "a", atMs: daysAgo(60) },
        { source: "b", atMs: daysAgo(50) },
        { source: "c", atMs: daysAgo(40) },
        { source: "calendar", atMs: daysAhead(7) }
      ]
    };
    expect(selectEarnedThemes([staleWithFuture], { nowMs: NOW })).toEqual([]);
  });

  it("does NOT earn on future corroboration — one past mention plus upcoming events is not persistence", () => {
    const mostlyFuture: ThemeSignal = {
      theme: "trip",
      occurrences: [
        { source: "query", atMs: daysAgo(1) },
        { source: "calendar", atMs: daysAhead(3) },
        { source: "calendar2", atMs: daysAhead(10) }
      ]
    };
    expect(selectEarnedThemes([mostlyFuture], { nowMs: NOW })).toEqual([]); // only 1 past occurrence < minOccurrences
  });

  it("computes dwell/recency from past occurrences only, ignoring a trailing future event", () => {
    const earned = selectEarnedThemes(
      [{
        theme: "house move",
        occurrences: [
          { source: "notes/move.md", atMs: daysAgo(6) },
          { source: "calendar", atMs: daysAgo(4) },
          { source: "query", atMs: daysAgo(1) },
          { source: "calendar", atMs: daysAhead(5) } // future — excluded
        ]
      }],
      { nowMs: NOW }
    );
    expect(earned[0]!.occurrences).toBe(3); // future one not counted
    expect(earned[0]!.dwellDays).toBeCloseTo(5, 0); // 6d ago → 1d ago, not into the future
    expect(earned[0]!.recencyDays).toBeCloseTo(1, 0); // last PAST occurrence, not the future event
  });

  it("ranks the most-established (dwell × sources) first and caps the list", () => {
    const big: ThemeSignal = { theme: "big", occurrences: [{ source: "a", atMs: daysAgo(10) }, { source: "b", atMs: daysAgo(5) }, { source: "c", atMs: daysAgo(1) }] };
    const small: ThemeSignal = { theme: "small", occurrences: [{ source: "a", atMs: daysAgo(4) }, { source: "b", atMs: daysAgo(3) }, { source: "a", atMs: daysAgo(1) }] };
    const ranked = selectEarnedThemes([small, big], { nowMs: NOW });
    expect(ranked[0]!.theme).toBe("big");
    expect(selectEarnedThemes([big, small], { nowMs: NOW, maxResults: 1 })).toHaveLength(1);
  });
});
