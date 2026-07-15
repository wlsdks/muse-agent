import { describe, expect, it } from "vitest";

import { errorMessage, isRecord, parseJson, parseJsonWith } from "../src/browser.js";

describe("browser shared entry point", () => {
  it("exports the JSON parsing and record guards used by browser streams", () => {
    const parsed = parseJson('{"answer":"ready"}');
    expect(parsed).toEqual({ answer: "ready" });
    expect(parseJson("not json")).toBeUndefined();
    expect(parseJsonWith('{"answer":"ready"}', isRecord)).toEqual({ answer: "ready" });
    expect(parseJsonWith("[]", isRecord)).toBeUndefined();
  });

  it("normalizes Error, error-like, and fallback messages without Node APIs", () => {
    expect(errorMessage(new Error("network failed"))).toBe("network failed");
    expect(errorMessage({ message: "request failed" })).toBe("request failed");
    expect(errorMessage(undefined, "Request failed.")).toBe("Request failed.");
  });
});
