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

  it("takes the first balanced object when the model trails an example (goal 304)", () => {
    const result = normalizeStructuredOutput(
      "Result: {\"answer\":42}. For example {\"answer\":0}",
      "json"
    );
    expect(result).toEqual({
      content: "{\n  \"answer\": 42\n}",
      normalized: true
    });
  });

  it("extracts a prose-embedded JSON array with a trailing blob", () => {
    const result = normalizeStructuredOutput(
      "Items: [1,2,3] (e.g. [9])",
      "json"
    );
    expect(result).toEqual({
      content: "[\n  1,\n  2,\n  3\n]",
      normalized: true
    });
  });

  it("does not let a brace inside a string close the value early", () => {
    const result = normalizeStructuredOutput(
      "Here: {\"motto\":\"closes } here\",\"n\":1} trailing",
      "json"
    );
    expect(result).toEqual({
      content: "{\n  \"motto\": \"closes } here\",\n  \"n\": 1\n}",
      normalized: true
    });
  });

  it("does not let an ESCAPED quote end a string early — a \\\" (even before a brace) keeps the value balanced", () => {
    // The brace-in-string guard only works if the string-boundary scan honours
    // backslash escapes: a `\"` must NOT toggle out of the string, so a `}` that
    // follows it inside the value still doesn't close the object. Mutation-
    // surfaced: the escape branch had no test exercising an escaped quote.
    const result = normalizeStructuredOutput(
      "Here you go:\n{\"msg\":\"she said \\\"hi}\\\" then left\",\"ok\":true}\nThanks!",
      "json"
    );
    expect(result.normalized).toBe(true);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ msg: "she said \"hi}\" then left", ok: true });
  });

  it("recovers the valid object after a non-JSON bracketed preamble (skips the bad first block)", () => {
    const result = normalizeStructuredOutput("see [details below]: {\"ok\":true}", "json");
    expect(result).toEqual({
      content: "{\n  \"ok\": true\n}",
      normalized: true
    });
  });

  it("still prefers the FIRST balanced block when it is itself valid (does not skip past a good early value)", () => {
    const result = normalizeStructuredOutput("Items: [1,2,3] then {\"n\":1}", "json");
    expect(result).toEqual({
      content: "[\n  1,\n  2,\n  3\n]",
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
