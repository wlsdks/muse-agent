import { describe, expect, it } from "vitest";

// Importing through ./index.js (rather than ./provider-base.js
// directly) keeps the module-init order consistent with how
// agent-core actually loads provider-base. The runtime cycle
// (provider-base → provider-wire → provider-anthropic → index →
//  adapter-openai extends OpenAICompatibleProvider) only resolves
// when index.ts is the first thing the loader touches. See the
// header comment in provider-base.ts.
import { ModelProviderError, isRetryableHttpStatus } from "./index.js";

describe("isRetryableHttpStatus (goal 106)", () => {
  it("classifies 429 (rate limit) as retryable across every provider", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it("classifies 408 (request timeout) as retryable — transient, request not processed", () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
  });

  it("classifies 5xx server errors as retryable", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(504)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it("classifies the rest of 4xx as fail-fast (caller's problem — bad key, bad model, malformed payload), incl. 499 just below the 5xx range", () => {
    for (const status of [400, 401, 403, 404, 405, 409, 415, 418, 422, 428, 499]) {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  });

  it("classifies 2xx/3xx as not retryable (caller shouldn't be asking about success codes)", () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(204)).toBe(false);
    expect(isRetryableHttpStatus(301)).toBe(false);
    expect(isRetryableHttpStatus(308)).toBe(false);
  });

  it("classifies status >= 600 as not retryable (out-of-spec values must not silently retry)", () => {
    expect(isRetryableHttpStatus(600)).toBe(false);
    expect(isRetryableHttpStatus(999)).toBe(false);
  });

  it("rejects non-finite inputs without retrying", () => {
    expect(isRetryableHttpStatus(NaN)).toBe(false);
    expect(isRetryableHttpStatus(Infinity)).toBe(false);
    expect(isRetryableHttpStatus(-1)).toBe(false);
  });

  it("seats the same precedence inside ModelProviderError — retryable defaults to false", () => {
    const err = new ModelProviderError("openai", "bad key");
    expect(err.retryable).toBe(false);
  });
});
