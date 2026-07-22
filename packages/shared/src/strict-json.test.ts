import { describe, expect, it } from "vitest";

import { parseStrictJson, StrictJsonError } from "./strict-json.js";

describe("parseStrictJson", () => {
  it("parses nested JSON without changing values", () => {
    expect(parseStrictJson('{"a":[1,true,null,{"b":"한글"}]}')).toEqual({ a: [1, true, null, { b: "한글" }] });
  });

  it.each([
    '{"a":1,"a":2}',
    '{"outer":{"x":1,"x":2}}',
    '{"a":1,"\\u0061":2}'
  ])("rejects duplicate keys before JSON.parse can erase them: %s", (text) => {
    expect(() => parseStrictJson(text)).toThrow(/duplicate JSON key/u);
  });

  it.each(["", "{", "[1,]", '{"a":}', "true false", '"unterminated'])('rejects malformed JSON: %s', (text) => {
    expect(() => parseStrictJson(text)).toThrow(StrictJsonError);
  });

  it("enforces structural resource limits", () => {
    expect(() => parseStrictJson("[[[0]]]", { maxDepth: 2 })).toThrow(/depth limit/u);
    expect(() => parseStrictJson("[1,2]", { maxArrayItems: 1 })).toThrow(/array item limit/u);
    expect(() => parseStrictJson('{"a":1,"b":2}', { maxObjectMembers: 1 })).toThrow(/object member limit/u);
    expect(() => parseStrictJson("[1,2]", { maxNodes: 2 })).toThrow(/node limit/u);
  });
});
