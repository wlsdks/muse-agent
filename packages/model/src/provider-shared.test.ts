import { describe, expect, it } from "vitest";

import { recoverToolArgsJson } from "./provider-shared.js";

describe("recoverToolArgsJson", () => {
  it("normalizes non-finite numbers from otherwise valid JSON before tool execution", () => {
    expect(recoverToolArgsJson('{"finite":1,"overflow":1e400,"nested":[-1e400]}')).toEqual({
      finite: 1,
      nested: [null],
      overflow: null
    });
  });
});
