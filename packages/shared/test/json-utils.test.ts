import { describe, expect, it } from "vitest";

import { assertPlainDataTree } from "../src/json-utils.js";

describe("assertPlainDataTree", () => {
  it("rejects proxies without invoking caller-owned traps", () => {
    let trapCalls = 0;
    const proxy = new Proxy(
      { safe: true },
      {
        getOwnPropertyDescriptor() {
          trapCalls += 1;
          throw new Error("proxy trap must not run");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("proxy trap must not run");
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error("proxy trap must not run");
        }
      }
    );

    expect(() => assertPlainDataTree(proxy, "payload")).toThrow(
      "payload must be plain JSON data"
    );
    expect(trapCalls).toBe(0);
  });
});
