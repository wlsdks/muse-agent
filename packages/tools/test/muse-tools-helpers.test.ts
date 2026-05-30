import { describe, expect, it } from "vitest";

import {
  readOptionalDate,
  readOptionalNumber,
  readOptionalString,
  readRequiredDate
} from "../src/muse-tools-helpers.js";

// Direct coverage for the shared tool-argument parsers (untested module). These
// underpin every built-in tool's argument handling, so their absent/invalid/
// valid distinctions are the foundation of ArgumentCorrectness. The
// readOptionalDate three-state is the load-bearing one: collapsing "absent" and
// "malformed" (as readRequiredDate does) would let a tool that defaults a
// missing reference to now() silently anchor to the wrong instant on a bad
// value — a wrong answer with no error.

describe("readOptionalString", () => {
  it("returns a non-empty string, else undefined (empty / non-string / missing)", () => {
    expect(readOptionalString({ a: "x" }, "a")).toBe("x");
    expect(readOptionalString({ a: "" }, "a")).toBeUndefined();
    expect(readOptionalString({ a: 5 }, "a")).toBeUndefined();
    expect(readOptionalString({}, "a")).toBeUndefined();
  });
});

describe("readRequiredDate", () => {
  it("parses a valid ISO string to a Date", () => {
    expect(readRequiredDate({ a: "2026-05-30T00:00:00Z" }, "a")?.toISOString()).toBe("2026-05-30T00:00:00.000Z");
  });

  it("returns undefined for empty, non-string, or unparseable input", () => {
    expect(readRequiredDate({ a: "" }, "a")).toBeUndefined();
    expect(readRequiredDate({ a: "nope" }, "a")).toBeUndefined();
    expect(readRequiredDate({ a: 5 }, "a")).toBeUndefined();
  });
});

describe("readOptionalNumber", () => {
  it("returns a finite number, else 0 (NaN / Infinity / string / missing)", () => {
    expect(readOptionalNumber({ a: 3.5 }, "a")).toBe(3.5);
    expect(readOptionalNumber({ a: Number.NaN }, "a")).toBe(0);
    expect(readOptionalNumber({ a: Number.POSITIVE_INFINITY }, "a")).toBe(0);
    expect(readOptionalNumber({ a: "5" }, "a")).toBe(0); // a string number is NOT coerced
    expect(readOptionalNumber({}, "a")).toBe(0);
  });
});

describe("readOptionalDate", () => {
  it("treats undefined / null / empty-string as ABSENT (not invalid)", () => {
    expect(readOptionalDate({}, "a")).toEqual({ kind: "absent" });
    expect(readOptionalDate({ a: null }, "a")).toEqual({ kind: "absent" });
    expect(readOptionalDate({ a: "" }, "a")).toEqual({ kind: "absent" }); // model emitting "" for an unset optional
  });

  it("treats a non-string or unparseable string as INVALID (distinct from absent)", () => {
    expect(readOptionalDate({ a: 5 }, "a")).toEqual({ kind: "invalid" });
    expect(readOptionalDate({ a: "nope" }, "a")).toEqual({ kind: "invalid" });
  });

  it("returns a parsed Date for a valid ISO string", () => {
    const result = readOptionalDate({ a: "2026-01-01T00:00:00Z" }, "a");
    expect(result.kind).toBe("date");
    expect(result.kind === "date" && result.date.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
