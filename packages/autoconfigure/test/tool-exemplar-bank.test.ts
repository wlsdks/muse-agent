import { describe, expect, it } from "vitest";

import { buildToolExemplarBank } from "../src/context-engineering-builders.js";
import type { MuseEnvironment } from "../src/index.js";

function envWith(overrides: Record<string, string>): MuseEnvironment {
  return overrides as unknown as MuseEnvironment;
}

describe("buildToolExemplarBank — PTC few-shot seed wired into the production runtime", () => {
  it("returns the seed bank by default (default-on), teaching run_tool_plan", () => {
    const bank = buildToolExemplarBank(envWith({}));
    expect(bank).toBeDefined();
    expect(bank!.length).toBeGreaterThan(0);
    expect(bank!.some((exemplar) => exemplar.tool === "run_tool_plan")).toBe(true);
    // restraint cases present so the bank doesn't bias toward over-firing
    expect(bank!.some((exemplar) => exemplar.tool === null)).toBe(true);
    expect(bank!.some((exemplar) => exemplar.tool !== null && exemplar.tool !== "run_tool_plan")).toBe(true);
  });

  it("withholds the bank when MUSE_TOOL_EXEMPLARS=false (clean opt-out)", () => {
    expect(buildToolExemplarBank(envWith({ MUSE_TOOL_EXEMPLARS: "false" }))).toBeUndefined();
  });

  it("stays on for any non-false value", () => {
    expect(buildToolExemplarBank(envWith({ MUSE_TOOL_EXEMPLARS: "true" }))).toBeDefined();
  });
});
