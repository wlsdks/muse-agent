import { describe, expect, it } from "vitest";

import { encodeLocalCheckpointReference } from "@muse/shared";
import { checkpointReferenceResumeRefusal, formatResumableRuns } from "./commands-resume.js";

describe("formatResumableRuns", () => {
  it("guides the user when there's nothing to resume", () => {
    expect(formatResumableRuns([])).toContain("No interrupted runs");
  });
  it("lists each interrupted run with its stopped step + phase", () => {
    const out = formatResumableRuns([
      { runId: "run-abc", step: 3, phase: "act", updatedAt: new Date("2026-06-28T10:00:00Z") }
    ]);
    expect(out).toContain("run-abc");
    expect(out).toContain("step 3");
    expect(out).toContain("act");
    expect(out).toContain("muse resume <run-id>");
  });
});

describe("checkpointReferenceResumeRefusal", () => {
  it("keeps Continuity checkpoint locators out of the execution authority path", () => {
    const reference = encodeLocalCheckpointReference({ runId: "run_exact", step: 2, workspaceRealpath: "/workspace/project" });
    expect(checkpointReferenceResumeRefusal(reference)).toContain("context-only");
    expect(checkpointReferenceResumeRefusal("run_exact")).toBeUndefined();
  });
});
