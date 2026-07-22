import { describe, expect, it } from "vitest";

import { checkpointContinuityEvidenceFromMessages } from "./lifecycle.js";

describe("checkpointContinuityEvidenceFromMessages", () => {
  it("uses only the latest user-authored input and bounds it", () => {
    const evidence = checkpointContinuityEvidenceFromMessages([
      { content: "older secret", role: "user" },
      { content: "assistant output", role: "assistant" },
      { content: `  ${"가".repeat(200)}\nlatest request  `, role: "user" },
      { content: "tool secret", name: "tool", role: "tool", toolCallId: "call_1" }
    ], "act");
    expect(evidence?.phase).toBe("act");
    expect(evidence?.query).toContain("가");
    expect(evidence?.query).not.toContain("older secret");
    expect(evidence?.query).not.toContain("assistant output");
    expect(evidence?.query).not.toContain("tool secret");
    expect(new TextEncoder().encode(evidence!.query).byteLength).toBeLessThanOrEqual(240);
  });

  it("omits evidence for unknown phases or missing user input", () => {
    expect(checkpointContinuityEvidenceFromMessages([{ content: "system", role: "system" }], "start")).toBeUndefined();
    expect(checkpointContinuityEvidenceFromMessages([{ content: "request", role: "user" }], "custom")).toBeUndefined();
  });
});
