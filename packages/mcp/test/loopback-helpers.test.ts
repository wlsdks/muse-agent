import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  buildJsonToolSchema,
  errorMessage,
  readBoolean,
  readJsonObject,
  readString,
  readStringArray
} from "../src/loopback-helpers.js";

describe("loopback-helpers — shared tool-arg shape readers", () => {
  it("readString returns a string value, undefined for a non-string or missing key", () => {
    expect(readString({ k: "hi" } as unknown as JsonObject, "k")).toBe("hi");
    expect(readString({ k: 5 } as unknown as JsonObject, "k")).toBeUndefined();
    expect(readString({} as JsonObject, "k")).toBeUndefined();
  });

  it("readStringArray keeps only string entries, undefined when the value isn't an array", () => {
    expect(readStringArray({ k: ["a", "b"] } as unknown as JsonObject, "k")).toEqual(["a", "b"]);
    expect(readStringArray({ k: ["a", 1, true, "b"] } as unknown as JsonObject, "k")).toEqual(["a", "b"]); // non-strings filtered
    expect(readStringArray({ k: "a,b" } as unknown as JsonObject, "k")).toBeUndefined(); // not an array
    expect(readStringArray({} as JsonObject, "k")).toBeUndefined();
  });

  it("readBoolean accepts only a real boolean (not the string 'true')", () => {
    expect(readBoolean({ k: true } as unknown as JsonObject, "k")).toBe(true);
    expect(readBoolean({ k: false } as unknown as JsonObject, "k")).toBe(false);
    expect(readBoolean({ k: "true" } as unknown as JsonObject, "k")).toBeUndefined();
    expect(readBoolean({} as JsonObject, "k")).toBeUndefined();
  });

  it("readJsonObject accepts a plain object, rejecting arrays / null / primitives", () => {
    expect(readJsonObject({ k: { a: 1 } } as unknown as JsonObject, "k")).toEqual({ a: 1 });
    expect(readJsonObject({ k: [] } as unknown as JsonObject, "k")).toBeUndefined(); // array
    expect(readJsonObject({ k: null } as unknown as JsonObject, "k")).toBeUndefined();
    expect(readJsonObject({ k: "x" } as unknown as JsonObject, "k")).toBeUndefined();
    expect(readJsonObject({} as JsonObject, "k")).toBeUndefined();
  });

  it("errorMessage extracts an Error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
  });
});

describe("buildJsonToolSchema — closed object schema builder", () => {
  it("emits a closed object schema with the given properties", () => {
    const schema = buildJsonToolSchema({ name: { type: "string" } });
    expect(schema).toEqual({ additionalProperties: false, properties: { name: { type: "string" } }, type: "object" });
  });

  it("includes a non-empty required list and DROPS an empty one (no noisy required: [])", () => {
    expect(buildJsonToolSchema({ name: { type: "string" } }, ["name"])).toMatchObject({ required: ["name"] });
    expect(buildJsonToolSchema({ name: { type: "string" } }, [])).not.toHaveProperty("required");
    expect(buildJsonToolSchema({ name: { type: "string" } })).not.toHaveProperty("required");
  });

  it("always closes the object (additionalProperties:false) for strict MCP compliance", () => {
    expect(buildJsonToolSchema({}).additionalProperties).toBe(false);
  });
});
