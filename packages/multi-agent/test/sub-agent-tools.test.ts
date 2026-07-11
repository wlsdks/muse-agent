import { describe, expect, it } from "vitest";
import { inheritParentToolDeny } from "../src/index.js";

describe("inheritParentToolDeny", () => {
  it("drops a child tool the parent lacked (intersection, parent order preserved)", () => {
    expect(inheritParentToolDeny(["a", "b"], ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("clamps an unrestricted child down to the parent's set", () => {
    expect(inheritParentToolDeny(["a", "b"], undefined)).toEqual(["a", "b"]);
  });

  it("imposes no ceiling when the parent itself is unrestricted", () => {
    expect(inheritParentToolDeny(undefined, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("both unrestricted stays unrestricted", () => {
    expect(inheritParentToolDeny(undefined, undefined)).toBeUndefined();
  });

  it("a disjoint child set clamps to an empty allowlist — a legitimate hard clamp", () => {
    expect(inheritParentToolDeny(["a"], ["b"])).toEqual([]);
  });

  it("never mutates its inputs and returns a fresh array", () => {
    const parent = ["a", "b"];
    const child = ["a", "b", "c"];
    const result = inheritParentToolDeny(parent, child);
    expect(parent).toEqual(["a", "b"]);
    expect(child).toEqual(["a", "b", "c"]);
    expect(result).not.toBe(parent);
    expect(result).not.toBe(child);
  });

  it("never mutates the parent when the child is undefined, and returns a fresh array", () => {
    const parent = ["a", "b"];
    const result = inheritParentToolDeny(parent, undefined);
    expect(parent).toEqual(["a", "b"]);
    expect(result).not.toBe(parent);
  });

  it("never mutates the child when the parent is undefined, and returns a fresh array", () => {
    const child = ["a", "b"];
    const result = inheritParentToolDeny(undefined, child);
    expect(child).toEqual(["a", "b"]);
    expect(result).not.toBe(child);
  });
});
