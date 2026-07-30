import { describe, expect, it } from "vitest";

import {
  findThreadRootedWitnessPath
} from "./thread-rooted-witness-path.js";
import type {
  GraphAssertion,
  GraphDirection,
  GraphRef
} from "./types.js";

const THREAD = Object.freeze({ id: "thread", kind: "thread" } as const);
const A = Object.freeze({ id: "a", kind: "artifact" } as const);
const B = Object.freeze({ id: "b", kind: "artifact" } as const);
const C = Object.freeze({ id: "c", kind: "artifact" } as const);

function assertion(
  id: string,
  subject: GraphRef,
  object: GraphRef
): GraphAssertion {
  return Object.freeze({
    schemaVersion: 1,
    id,
    subject,
    predicate: "LINKED_TO",
    object,
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([{ id: `source-${id}`, namespace: "test" }]),
    recordedAt: "2026-07-29T00:00:00.000Z",
    derivation: Object.freeze({ kind: "projection", version: "test-v1" })
  });
}

function ids(
  targetAssertionId: string,
  assertions: readonly GraphAssertion[],
  direction: GraphDirection,
  maxDepth = 8
): readonly string[] | undefined {
  return findThreadRootedWitnessPath(
    THREAD,
    targetAssertionId,
    assertions,
    direction,
    maxDepth
  )?.map((step) => `${step.assertion.id}:${step.direction}`);
}

describe("findThreadRootedWitnessPath", () => {
  it("honors outgoing, incoming, and both traversal directions", () => {
    const outgoing = assertion("outgoing", THREAD, A);
    const incoming = assertion("incoming", B, THREAD);

    expect(ids("outgoing", [incoming, outgoing], "outgoing"))
      .toEqual(["outgoing:outgoing"]);
    expect(ids("incoming", [incoming, outgoing], "incoming"))
      .toEqual(["incoming:incoming"]);
    expect(ids("incoming", [outgoing, incoming], "both"))
      .toEqual(["incoming:incoming"]);
  });

  it("uses the raw ID and direction comparator for deterministic shortest ties", () => {
    const first = assertion("a-first", THREAD, A);
    const second = assertion("b-second", THREAD, B);
    const target = assertion("target", A, B);

    expect(ids("target", [second, target, first], "both"))
      .toEqual(["a-first:outgoing", "target:outgoing"]);
  });

  it("sorts a both-direction self-loop incoming before outgoing", () => {
    const target = assertion("target", THREAD, THREAD);
    expect(ids("target", [target], "both")).toEqual(["target:incoming"]);
  });

  it("checks a target before visited-ref pruning", () => {
    const target = assertion("target", THREAD, THREAD);
    expect(ids("target", [target], "outgoing")).toEqual(["target:outgoing"]);
  });

  it("avoids cycles and assertion reuse while retaining a reachable path", () => {
    const toA = assertion("to-a", THREAD, A);
    const back = assertion("back", A, THREAD);
    const toB = assertion("to-b", A, B);
    const target = assertion("target", B, C);

    expect(ids("target", [target, back, toB, toA], "outgoing"))
      .toEqual(["to-a:outgoing", "to-b:outgoing", "target:outgoing"]);
  });

  it("enforces maxDepth boundaries and returns undefined when unreachable", () => {
    const first = assertion("first", THREAD, A);
    const target = assertion("target", A, B);

    expect(ids("first", [first, target], "outgoing", 0)).toBeUndefined();
    expect(ids("target", [first, target], "outgoing", 1)).toBeUndefined();
    expect(ids("target", [first, target], "outgoing", 2))
      .toEqual(["first:outgoing", "target:outgoing"]);
    expect(ids("absent", [first, target], "outgoing")).toBeUndefined();
  });

  it("preserves the frozen null-prototype runtime shape and input identities", () => {
    const target = assertion("target", THREAD, A);
    const path = findThreadRootedWitnessPath(
      THREAD,
      target.id,
      [target],
      "outgoing",
      1
    );
    const step = path?.[0];

    expect(path).toBeDefined();
    expect(Object.isFrozen(path)).toBe(true);
    expect(step).toBeDefined();
    expect(Object.isFrozen(step)).toBe(true);
    expect(Object.getPrototypeOf(step)).toBeNull();
    expect(Object.keys(step ?? {})).toEqual(["assertion", "direction", "from", "to"]);
    expect(Object.getOwnPropertyDescriptor(step, "assertion")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: target,
      writable: false
    });
    expect(Object.getOwnPropertyDescriptor(step, "direction")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: "outgoing",
      writable: false
    });
    expect(Object.getOwnPropertyDescriptor(step, "from")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: THREAD,
      writable: false
    });
    expect(Object.getOwnPropertyDescriptor(step, "to")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: A,
      writable: false
    });
    expect(step?.assertion).toBe(target);
    expect(step?.from).toBe(THREAD);
    expect(step?.to).toBe(A);
  });
});
