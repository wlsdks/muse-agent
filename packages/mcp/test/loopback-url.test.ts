import { describe, expect, it } from "vitest";

import { createUrlMcpServer } from "../src/loopback-url-server.js";

const tool = (name: string) => {
  const found = createUrlMcpServer().tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
};

describe("muse.url#parse", () => {
  it("splits every component of a fully-populated URL", () => {
    expect(tool("parse").execute({ url: "https://bob:pw@example.com:8443/a/b?y=hi#frag" })).toEqual({
      hash: "#frag",
      host: "example.com:8443",
      hostname: "example.com",
      origin: "https://example.com:8443",
      password: "pw",
      pathname: "/a/b",
      port: "8443",
      protocol: "https:",
      query: { y: "hi" },
      search: "?y=hi",
      username: "bob",
    });
  });

  it("collapses a repeated query key into an ordered array, keeps single keys scalar", () => {
    const out = tool("parse").execute({ url: "http://h.test/?x=1&x=2&x=3&y=hi" }) as {
      query: Record<string, string | string[]>;
    };
    expect(out.query).toEqual({ x: ["1", "2", "3"], y: "hi" });
  });

  it("represents a key with no value as an empty string", () => {
    const out = tool("parse").execute({ url: "http://h.test/?a=" }) as { query: Record<string, unknown> };
    expect(out.query).toEqual({ a: "" });
  });

  it("returns an empty query map and empty optional components when absent", () => {
    expect(tool("parse").execute({ url: "http://h.test/" })).toMatchObject({
      hash: "",
      password: "",
      port: "",
      query: {},
      search: "",
      username: "",
    });
  });

  it("reports a missing or empty url before attempting to parse", () => {
    expect(tool("parse").execute({})).toEqual({ error: "url is required" });
    expect(tool("parse").execute({ url: "" })).toEqual({ error: "url is required" });
  });

  it("surfaces a parse failure as an error rather than throwing", () => {
    expect(tool("parse").execute({ url: "::nope::" })).toMatchObject({
      error: expect.stringContaining("invalid URL"),
    });
    // The WHATWG URL constructor requires an absolute URL — a bare
    // relative path has no scheme and must fail closed.
    expect(tool("parse").execute({ url: "/just/a/path" })).toMatchObject({
      error: expect.stringContaining("invalid URL"),
    });
  });
});

describe("muse.url#encode_query", () => {
  it("encodes scalar and array values, repeating the key per array item", () => {
    expect(tool("encode_query").execute({ params: { a: "1", b: ["2", "3"] } })).toEqual({ query: "a=1&b=2&b=3" });
  });

  it("stringifies non-string scalars and skips null / undefined values", () => {
    expect(
      tool("encode_query").execute({ params: { n: 5, bool: true, nul: null, und: undefined } }),
    ).toEqual({ query: "n=5&bool=true" });
    // A nested object is NOT a scalar — it must error, not encode "[object Object]"
    // (covered end-to-end in mcp.test.ts). Asserting the rejection here too keeps this
    // unit honest about what encode_query accepts.
    expect(tool("encode_query").execute({ params: { obj: { x: 1 } } })).toEqual({
      error: expect.stringContaining("string/number/boolean"),
    });
  });

  it("skips null / undefined ARRAY items (matching the scalar branch), never encodes them as 'null'", () => {
    // The scalar branch skips null/undefined (above); the array branch must too —
    // otherwise ["a", null, "b"] silently emits a corrupt tags=null param.
    expect(tool("encode_query").execute({ params: { tags: ["a", null, undefined, "b"] } })).toEqual({
      query: "tags=a&tags=b",
    });
    // a nested object inside an array is still rejected (not skipped)
    expect(tool("encode_query").execute({ params: { tags: ["a", { x: 1 }] } })).toEqual({
      error: expect.stringContaining("string/number/boolean"),
    });
    // falsy-but-VALID scalars (0, false, "") must still encode — the skip is strict null/undefined only
    expect(tool("encode_query").execute({ params: { v: [0, false, ""] } })).toEqual({ query: "v=0&v=false&v=" });
  });

  it("percent-encodes reserved characters (space, &, =) in values", () => {
    expect(tool("encode_query").execute({ params: { q: "a b&c=d" } })).toEqual({ query: "q=a+b%26c%3Dd" });
  });

  it("returns an empty query string for an empty object", () => {
    expect(tool("encode_query").execute({ params: {} })).toEqual({ query: "" });
  });

  it("rejects params that are not a plain object (null, array, primitive, missing)", () => {
    for (const params of [null, [1, 2], 5, "nope", undefined]) {
      expect(tool("encode_query").execute({ params })).toEqual({ error: "params must be a JSON object" });
    }
  });
});
