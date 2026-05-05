import { describe, expect, it } from "vitest";
import { normalizeStructuredOutput } from "../src/index.js";

describe("normalizeStructuredOutput", () => {
  it("normalizes fenced JSON into stable JSON text", () => {
    const result = normalizeStructuredOutput("```json\n{\"b\":2,\"a\":1}\n```", "json");

    expect(result).toEqual({
      content: "{\n  \"b\": 2,\n  \"a\": 1\n}",
      normalized: true
    });
  });

  it("extracts JSON from extra model prose", () => {
    const result = normalizeStructuredOutput("Here is the object:\n{\"ok\":true}\nDone.", "json");

    expect(result).toEqual({
      content: "{\n  \"ok\": true\n}",
      normalized: true
    });
  });

  it("fails open when JSON is invalid", () => {
    const result = normalizeStructuredOutput("{\"ok\":", "json");

    expect(result.content).toBe("{\"ok\":");
    expect(result.normalized).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("strips YAML fences without reinterpreting content", () => {
    const result = normalizeStructuredOutput("```yaml\nok: true\n```", "yaml");

    expect(result).toEqual({
      content: "ok: true",
      normalized: true
    });
  });
});
