import { describe, expect, it } from "vitest";

import { redactMcpSecrets } from "../src/mcp-tool-factory.js";

describe("redactMcpSecrets", () => {
  it("redacts a Bearer token (existing behavior, unchanged)", () => {
    const out = redactMcpSecrets("401 Unauthorized — sent Authorization: Bearer sk-live-SUPERSECRET123");
    expect(out).not.toContain("SUPERSECRET123");
    expect(out).toContain("Bearer [redacted]");
  });

  it("redacts a Basic credential", () => {
    const out = redactMcpSecrets("403 Forbidden — sent Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZDEyMw==");
    expect(out).toContain("Basic [redacted]");
  });

  it("redacts an X-API-Key header", () => {
    const out = redactMcpSecrets("upstream rejected request: X-API-Key: sk-proj-ABCDEF0123456789");
    expect(out).not.toContain("sk-proj-ABCDEF0123456789");
    expect(out.toLowerCase()).toContain("x-api-key: [redacted]");
  });

  it("redacts a lowercase api-key header", () => {
    const out = redactMcpSecrets("headers sent: api-key: abcdef0123456789");
    expect(out).not.toContain("abcdef0123456789");
    expect(out).toContain("api-key: [redacted]");
  });

  it("redacts a token= query parameter", () => {
    const out = redactMcpSecrets("GET https://api.example.com/data?token=abcdef0123456789&user=bob failed");
    expect(out).not.toContain("abcdef0123456789");
    expect(out).toContain("token=[redacted]");
    expect(out).toContain("user=bob");
  });

  it("redacts api_key / apikey / access_token query params", () => {
    expect(redactMcpSecrets("call failed: api_key=SECRETVALUE1")).not.toContain("SECRETVALUE1");
    expect(redactMcpSecrets("call failed: apikey=SECRETVALUE2")).not.toContain("SECRETVALUE2");
    expect(redactMcpSecrets("call failed: access_token=SECRETVALUE3")).not.toContain("SECRETVALUE3");
  });

  it("redacts a generic Authorization scheme that isn't Bearer/Basic", () => {
    const out = redactMcpSecrets(
      "signed request rejected: Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=deadbeef"
    );
    expect(out).not.toContain("AKIAEXAMPLE");
    expect(out).not.toContain("deadbeef");
    expect(out).toContain("Authorization: [redacted]");
  });

  it("does not mangle ordinary non-secret text using the same words", () => {
    expect(redactMcpSecrets("the rate limiter uses a token bucket algorithm")).toBe(
      "the rate limiter uses a token bucket algorithm"
    );
    expect(redactMcpSecrets("see the docs for basic usage instructions")).toBe(
      "see the docs for basic usage instructions"
    );
    expect(redactMcpSecrets("this API key rotation policy runs weekly")).toBe(
      "this API key rotation policy runs weekly"
    );
    expect(redactMcpSecrets("Basic auth is required for this endpoint")).toBe(
      "Basic auth is required for this endpoint"
    );
  });

  it("leaves a message with no credential shape completely unchanged", () => {
    const message = "MCP tool 'read_file' failed: HTTP 500 Internal Server Error";
    expect(redactMcpSecrets(message)).toBe(message);
  });
});
