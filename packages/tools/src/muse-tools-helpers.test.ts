import { describe, expect, it } from "vitest";

import {
  readOptionalDate,
  readOptionalNumber,
  readOptionalString,
  readRequiredDate
} from "./muse-tools-helpers.js";

describe("readOptionalString", () => {
  it("returns the string when present and non-empty", () => {
    expect(readOptionalString({ foo: "hi" }, "foo")).toBe("hi");
  });
  it("returns undefined for empty strings", () => {
    expect(readOptionalString({ foo: "" }, "foo")).toBeUndefined();
  });
  it("returns undefined for non-string values", () => {
    expect(readOptionalString({ foo: 42 }, "foo")).toBeUndefined();
    expect(readOptionalString({ foo: null }, "foo")).toBeUndefined();
    expect(readOptionalString({}, "foo")).toBeUndefined();
  });
});

describe("readRequiredDate", () => {
  it("returns a Date for parseable ISO strings", () => {
    const d = readRequiredDate({ at: "2026-05-13T12:00:00Z" }, "at");
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe("2026-05-13T12:00:00.000Z");
  });
  it("returns undefined for unparseable strings", () => {
    expect(readRequiredDate({ at: "not a date" }, "at")).toBeUndefined();
  });
  it("returns undefined for empty / non-string values", () => {
    expect(readRequiredDate({ at: "" }, "at")).toBeUndefined();
    expect(readRequiredDate({ at: 42 }, "at")).toBeUndefined();
    expect(readRequiredDate({}, "at")).toBeUndefined();
  });
});

describe("readOptionalDate", () => {
  it("returns a date for parseable ISO strings", () => {
    const r = readOptionalDate({ reference: "2026-05-13T12:00:00Z" }, "reference");
    expect(r.kind).toBe("date");
    expect(r.kind === "date" && r.date.toISOString()).toBe("2026-05-13T12:00:00.000Z");
  });
  it("treats absent / null / empty-string as absent (not invalid)", () => {
    expect(readOptionalDate({}, "reference")).toEqual({ kind: "absent" });
    expect(readOptionalDate({ reference: null }, "reference")).toEqual({ kind: "absent" });
    expect(readOptionalDate({ reference: "" }, "reference")).toEqual({ kind: "absent" });
  });
  it("flags a present-but-unparseable value as invalid", () => {
    expect(readOptionalDate({ reference: "not a date" }, "reference")).toEqual({ kind: "invalid" });
    expect(readOptionalDate({ reference: 42 }, "reference")).toEqual({ kind: "invalid" });
  });
});

describe("readOptionalNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(readOptionalNumber({ n: 42 }, "n")).toBe(42);
    expect(readOptionalNumber({ n: -3.14 }, "n")).toBe(-3.14);
    expect(readOptionalNumber({ n: 0 }, "n")).toBe(0);
  });
  it("returns 0 for non-numeric / non-finite values", () => {
    expect(readOptionalNumber({ n: "42" }, "n")).toBe(0);
    expect(readOptionalNumber({ n: Number.POSITIVE_INFINITY }, "n")).toBe(0);
    expect(readOptionalNumber({ n: Number.NaN }, "n")).toBe(0);
    expect(readOptionalNumber({}, "n")).toBe(0);
  });
});
