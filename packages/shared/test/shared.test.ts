import { describe, expect, it } from "vitest";
import {
  createCancellationToken,
  createRunId,
  formatBoundaryViolation,
  hmacSha256Hex,
  sha256Hex,
  verifyHmacSha256Hex
} from "../src/index.js";

describe("createRunId", () => {
  it("uses a readable prefix", () => {
    expect(createRunId("muse")).toMatch(/^muse_[0-9a-f-]{36}$/);
  });
});

describe("shared crypto helpers", () => {
  it("produces deterministic SHA-256 and HMAC signatures", () => {
    const signature = hmacSha256Hex("payload", "secret");

    expect(sha256Hex("payload")).toBe("239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5");
    expect(signature).toBe("b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4");
    expect(verifyHmacSha256Hex("payload", `sha256=${signature}`, "secret")).toBe(true);
    expect(verifyHmacSha256Hex("payload", signature, "wrong")).toBe(false);
    expect(verifyHmacSha256Hex("payload", "not-a-hex-signature", "secret")).toBe(false);
  });
});

describe("boundary and cancellation helpers", () => {
  it("formats boundary violations consistently", () => {
    expect(
      formatBoundaryViolation({
        actual: "tool without assistant call",
        boundary: "assistant_tool_pair",
        expected: "assistant tool call before tool response",
        reason: "orphan tool response"
      })
    ).toBe(
      "Boundary violation: boundary=assistant_tool_pair; reason=orphan tool response; expected=assistant tool call before tool response; actual=tool without assistant call"
    );
  });

  it("exposes an abort signal with deterministic cancellation errors", () => {
    const token = createCancellationToken();

    expect(token.signal.aborted).toBe(false);
    token.cancel("timeout");

    expect(token.signal.aborted).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow("timeout");
  });
});
