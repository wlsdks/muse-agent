import { describe, expect, it } from "vitest";

import { parseOptionalIsoQueryParam } from "../src/calendar-routes.js";

describe("parseOptionalIsoQueryParam — three-way classification of optional ISO query params", () => {
  it("returns { kind: 'absent' } when the param is undefined", () => {
    expect(parseOptionalIsoQueryParam(undefined)).toEqual({ kind: "absent" });
  });

  it("treats an empty / whitespace-only string as absent (caller didn't really supply a value)", () => {
    expect(parseOptionalIsoQueryParam("")).toEqual({ kind: "absent" });
    expect(parseOptionalIsoQueryParam("   ")).toEqual({ kind: "absent" });
  });

  it("returns { kind: 'explicit', date } for a parseable ISO timestamp", () => {
    const result = parseOptionalIsoQueryParam("2026-05-21T09:00:00.000Z");
    expect(result.kind).toBe("explicit");
    if (result.kind === "explicit") {
      expect(result.date.toISOString()).toBe("2026-05-21T09:00:00.000Z");
    }
    // Date-only form is also accepted (matches `new Date(...)` leniency).
    const dateOnly = parseOptionalIsoQueryParam("2026-05-21");
    expect(dateOnly.kind).toBe("explicit");
  });

  it("returns { kind: 'invalid', raw } for present-but-unparseable values (the load-bearing distinction this iter adds)", () => {
    for (const bad of ["tomorrow", "not-a-date", "2026-13-99", "next monday", "now+1h"]) {
      const result = parseOptionalIsoQueryParam(bad);
      expect(result.kind, `"${bad}" must classify as invalid`).toBe("invalid");
      if (result.kind === "invalid") {
        // The original (un-normalised) raw is preserved so the route's 400 response
        // can echo exactly what the caller typed, not a normalised form.
        expect(result.raw).toBe(bad);
      }
    }
  });

  it("never silently falls back when the param is present (no kind: 'absent' on a typo)", () => {
    // The pre-fix behaviour was `parseIsoOrDefault("tomorrow", now)` → silent fallback to `now`.
    // The new contract refuses that: a present value MUST resolve to explicit-or-invalid,
    // so a route can `return 400` instead of executing the query with a wrong default.
    const result = parseOptionalIsoQueryParam("tomorrow");
    expect(result.kind).not.toBe("absent");
  });
});
