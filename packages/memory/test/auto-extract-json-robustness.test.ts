/**
 * Iter 9 regression guard for `extractJsonObject` — the parser
 * `runExtraction` uses to pull a JSON payload out of the model
 * reply. Smaller / cheaper extraction models sometimes wrap the
 * payload in prose or trail a comment, and the previous strict
 * trim+fence-strip path lost those replies entirely.
 */

import { describe, expect, it } from "vitest";

import { extractJsonObject } from "../src/memory-auto-extract.js";

describe("extractJsonObject (iter 9)", () => {
  it("parses a clean JSON object", () => {
    const out = extractJsonObject('{"facts": {"name": "Stark"}}');
    expect(out?.facts).toEqual({ name: "Stark" });
  });

  it("strips a fenced ```json block", () => {
    const out = extractJsonObject('```json\n{"facts": {"name": "Stark"}}\n```');
    expect(out?.facts).toEqual({ name: "Stark" });
  });

  it("strips a bare ``` fence", () => {
    const out = extractJsonObject('```\n{"facts": {}}\n```');
    expect(out?.facts).toEqual({});
  });

  it("recovers when the model added a prose prefix", () => {
    const out = extractJsonObject("Here's what I extracted:\n{\"facts\":{\"name\":\"Stark\"},\"preferences\":{},\"vetoes\":[],\"goals\":[]}");
    expect(out?.facts).toEqual({ name: "Stark" });
  });

  it("recovers when the model added a trailing comment after the JSON", () => {
    const out = extractJsonObject('{"facts": {"name": "Stark"}}\n// done');
    expect(out?.facts).toEqual({ name: "Stark" });
  });

  it("handles nested objects with strings that contain braces", () => {
    const out = extractJsonObject('Prefix prose. {"facts":{"motto":"hi {there}"}} trailing');
    expect(out?.facts).toEqual({ motto: "hi {there}" });
  });

  it("returns undefined for empty / non-object output", () => {
    expect(extractJsonObject("")).toBeUndefined();
    expect(extractJsonObject("not json at all")).toBeUndefined();
    expect(extractJsonObject("[1,2,3]")).toBeUndefined();
  });
});
