import { describe, expect, it } from "vitest";

import { backgroundProcessCheck } from "../src/commands-doctor-checks.js";

describe("backgroundProcessCheck (doctor)", () => {
  it("warns when a background process has failed", () => {
    const out = backgroundProcessCheck([{ id: "bg-1", status: "running" }, { id: "bg-2", status: "failed" }]);
    expect(out.status).toBe("warn");
    expect(out.detail).toContain("bg-2");
    expect(out.detail).toContain("muse bg logs");
  });

  it("reports the running count when none failed", () => {
    const out = backgroundProcessCheck([{ id: "a", status: "running" }, { id: "b", status: "exited" }]);
    expect(out.status).toBe("ok");
    expect(out.detail).toContain("1 background process(es) running");
  });

  it("reports none when empty", () => {
    expect(backgroundProcessCheck([])).toEqual({ detail: "no background processes", status: "ok" });
  });
});
