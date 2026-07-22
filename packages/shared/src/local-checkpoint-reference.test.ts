import { describe, expect, it } from "vitest";

import {
  decodeLocalCheckpointReference,
  encodeLocalCheckpointReference,
  isCanonicalCheckpointStep
} from "./local-checkpoint-reference.js";

describe("local checkpoint Continuity reference", () => {
  it("round-trips an exact workspace, run, and step byte-identically", () => {
    const expected = { runId: "run_123", step: 7, workspaceRealpath: "/Users/example/한글 project" };
    const encoded = encodeLocalCheckpointReference(expected);
    expect(decodeLocalCheckpointReference(encoded)).toEqual(expected);
    expect(encodeLocalCheckpointReference(decodeLocalCheckpointReference(encoded)!)).toBe(encoded);
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts canonical step %s", (step) => {
    expect(isCanonicalCheckpointStep(step)).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, "1"])("rejects step %#", (step) => {
    expect(isCanonicalCheckpointStep(step)).toBe(false);
  });

  it.each(["", "muse-checkpoint-v1:", "muse-checkpoint-v1:not+base64", "muse-run-v1:abc"])("rejects malformed reference %s", (value) => {
    expect(decodeLocalCheckpointReference(value)).toBeUndefined();
  });

  it.each(["/", "relative/project", "/workspace/../outside", "/workspace//project", "/workspace/project/"])("rejects workspace %s", (workspaceRealpath) => {
    expect(() => encodeLocalCheckpointReference({ runId: "run_123", step: 0, workspaceRealpath })).toThrow();
  });

  it("rejects non-canonical payload encodings instead of trimming or normalizing", () => {
    const canonical = encodeLocalCheckpointReference({ runId: "run_123", step: 0, workspaceRealpath: "/workspace/project" });
    expect(decodeLocalCheckpointReference(` ${canonical}`)).toBeUndefined();
    expect(decodeLocalCheckpointReference(`${canonical}=`)).toBeUndefined();
  });
});
