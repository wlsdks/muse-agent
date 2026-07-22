import { describe, expect, it } from "vitest";

import {
  canonicalRunOutcome,
  decodeLocalRunReference,
  encodeLocalRunReference,
  isCanonicalLocalRunId
} from "./local-run-reference.js";

describe("local run identity", () => {
  it.each(["run_123", "cli-123", "A.b_c-9"])("accepts canonical id %s", (value) => {
    expect(isCanonicalLocalRunId(value)).toBe(true);
  });

  it.each(["", " padded", "padded ", ".", "..", "a/b", "a\\b", "a:b", "line\nbreak", "한글"])(
    "rejects noncanonical id %s",
    (value) => expect(isCanonicalLocalRunId(value)).toBe(false)
  );

  it("bounds ids by UTF-8 bytes", () => {
    expect(isCanonicalLocalRunId(`r${"a".repeat(255)}`)).toBe(true);
    expect(isCanonicalLocalRunId(`r${"a".repeat(256)}`)).toBe(false);
  });
});

describe("local run Continuity reference", () => {
  it("round-trips one exact workspace and run id canonically", () => {
    const expected = { runId: "run_123", workspaceRealpath: "/Users/example/project" };
    const encoded = encodeLocalRunReference(expected);
    expect(decodeLocalRunReference(encoded)).toEqual(expected);
    expect(encodeLocalRunReference(decodeLocalRunReference(encoded)!)).toBe(encoded);
  });

  it.each(["", "muse-run-v1:", "muse-run-v1:not+base64", "other:abc"])("rejects malformed reference %s", (value) => {
    expect(decodeLocalRunReference(value)).toBeUndefined();
  });

  it("rejects relative workspace authority", () => {
    expect(() => encodeLocalRunReference({ runId: "run_123", workspaceRealpath: "relative/project" })).toThrow();
  });

  it.each([
    "/workspace/../outside",
    "/workspace/./project",
    "/workspace//project",
    "/workspace/project/",
    "C:\\workspace\\..\\outside",
    "C:/workspace//project"
  ])("rejects lexically noncanonical workspace path %s", (workspaceRealpath) => {
    expect(() => encodeLocalRunReference({ runId: "run_123", workspaceRealpath })).toThrow();
  });

  it("uses a browser-safe UTF-8 codec", () => {
    const expected = { runId: "run_123", workspaceRealpath: "/Users/example/한글 project" };
    expect(decodeLocalRunReference(encodeLocalRunReference(expected))).toEqual(expected);
  });
});

describe("canonical run outcome", () => {
  it.each(["abstain", "grounded", "misgrounded", "contested", "ungrounded", "error", null])(
    "accepts producer outcome %s",
    (value) => expect(canonicalRunOutcome(value)).toBe(value)
  );

  it("normalizes the exact legacy verdict envelope", () => {
    expect(canonicalRunOutcome({ verdict: "grounded" })).toBe("grounded");
  });

  it.each([undefined, "unknown", { verdict: "grounded", extra: true }, { verdict: "unknown" }, []])(
    "rejects malformed outcome %#",
    (value) => expect(canonicalRunOutcome(value)).toBeUndefined()
  );
});
