import { describe, expect, it } from "vitest";
import {
  createCancellationToken,
  createRunId,
  DEFAULT_ERROR_BODY_CAP,
  formatBoundaryViolation,
  hmacSha256Hex,
  redactSecretsInText,
  sha256Hex,
  truncateErrorBody,
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

  it("redactSecretsInText scrubs high-confidence credential shapes (goal 086)", () => {
    // OpenAI sk- + sk-proj-.
    expect(redactSecretsInText("rotate sk-proj-abcdefghijklmnopqrstuvwxyz today"))
      .toBe("rotate [redacted-openai-key] today");
    expect(redactSecretsInText("oldkey sk-abcdefghijklmnopqrstuvwxyz"))
      .toContain("[redacted-openai-key]");
    // Anthropic sk-ant-.
    expect(redactSecretsInText("note: sk-ant-api03-abcdefghijklmnop"))
      .toContain("[redacted-anthropic-key]");
    // GitHub PAT.
    expect(redactSecretsInText("gh token ghp_abcdefghijklmnopqrstuvwxyzABCDEF"))
      .toContain("[redacted-github-pat]");
    // AWS access key.
    expect(redactSecretsInText("AKIAIOSFODNN7EXAMPLE access"))
      .toContain("[redacted-aws-access-key]");
    // Google API key.
    expect(redactSecretsInText("key=AIzaSyABCDEF1234567890abcdef1234567890ABCDE"))
      .toContain("[redacted-google-api-key]");
    // Slack bot token.
    expect(redactSecretsInText("token=xoxb-12345-67890-AbCdEf"))
      .toContain("[redacted-slack-bot-token]");
    // JWT.
    expect(redactSecretsInText("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"))
      .toContain("[redacted-jwt]");
    // No false positive on plain English.
    expect(redactSecretsInText("Q3 budget memo due in 5 min"))
      .toBe("Q3 budget memo due in 5 min");
    // Empty / non-string input passes through.
    expect(redactSecretsInText("")).toBe("");
  });

  it("truncateErrorBody trims + caps + appends ellipsis when over the cap", () => {
    expect(truncateErrorBody("")).toBe("");
    expect(truncateErrorBody(undefined)).toBe("");
    expect(truncateErrorBody("  hi  ")).toBe("hi");
    expect(truncateErrorBody("x".repeat(DEFAULT_ERROR_BODY_CAP))).toHaveLength(DEFAULT_ERROR_BODY_CAP);
    const big = truncateErrorBody("x".repeat(DEFAULT_ERROR_BODY_CAP + 50));
    expect(big.endsWith("…")).toBe(true);
    expect(big.length).toBe(DEFAULT_ERROR_BODY_CAP + 1); // cap + ellipsis
    expect(truncateErrorBody("short", 4)).toBe("shor…");
  });
});
