import { describe, expect, it } from "vitest";

import { unwrapErrorMessage } from "../src/server.js";

describe("unwrapErrorMessage", () => {
  it("returns 'Agent run failed' for non-Error values", () => {
    expect(unwrapErrorMessage("nope")).toBe("Agent run failed");
    expect(unwrapErrorMessage(undefined)).toBe("Agent run failed");
    expect(unwrapErrorMessage(null)).toBe("Agent run failed");
  });

  it("returns the message for a single Error with no cause", () => {
    expect(unwrapErrorMessage(new Error("upstream 404"))).toBe("upstream 404");
  });

  it("joins the cause chain so the operator sees retry-wrapped Gemini errors", () => {
    const inner = new Error("Gemini request failed with 404: model not found");
    const middle = Object.assign(new Error("model provider error"), { cause: inner });
    const outer = Object.assign(new Error("Retry attempts exhausted after 3 attempt(s)"), {
      cause: middle
    });
    expect(unwrapErrorMessage(outer)).toBe(
      "Retry attempts exhausted after 3 attempt(s) — model provider error — Gemini request failed with 404: model not found"
    );
  });

  it("guards against a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(unwrapErrorMessage(a)).toBe("a — b");
  });

  it("scrubs credential shapes from the joined message (goal 145)", () => {
    // OpenAI's 401 sometimes echoes the partial Authorization header
    // into its diagnostic text. We don't want that landing on the
    // client / log verbatim.
    const inner = new Error("401: invalid token sk-proj-abcdefghijklmnopqrstuvwxyz");
    const outer = Object.assign(new Error("upstream auth failed"), { cause: inner });
    const message = unwrapErrorMessage(outer);
    expect(message).toContain("[redacted-openai-key]");
    expect(message).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(message).toContain("upstream auth failed");
    expect(message).toContain("401: invalid token");
  });

  it("redaction also catches GitHub PAT / Anthropic shapes in nested causes (goal 145)", () => {
    const inner = new Error("Anthropic 401 from sk-ant-api03-abcdefghijklmnop session");
    const outer = Object.assign(new Error("retry exhausted"), { cause: inner });
    expect(unwrapErrorMessage(outer)).toContain("[redacted-anthropic-key]");

    const githubInner = new Error("422 — ghp_abcdefghijklmnopqrstuvwxyzABCDEF lacks scope");
    expect(unwrapErrorMessage(githubInner)).toContain("[redacted-github-pat]");
  });
});
