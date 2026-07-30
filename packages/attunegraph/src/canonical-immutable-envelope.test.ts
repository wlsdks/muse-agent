import { createHash } from "node:crypto";
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_IMMUTABLE_ENVELOPE_LIMITS,
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope,
  canonicalizeImmutableEnvelopeForInternalUse,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";

import type {
  CanonicalImmutableEnvelopeErrorCode,
  CanonicalImmutableEnvelopeProfile
} from "./canonical-immutable-envelope.js";

const SPEC = Object.freeze({
  hashDomain: "attunegraph.canonical-envelope.fixture.v1",
  idField: "envelopeId",
  idPrefix: "attunegraph-envelope:test:sha256:"
});
const DIGEST = "8ab441c8a4d199126d0d6db0889105cf60534f67d0ab27170f883c150b0e8fcb";
const ID = `${SPEC.idPrefix}${DIGEST}`;
const UNSIGNED_JSON = "{\"-1\":\"minus\",\"01\":\"leading\",\"1\":\"one\",\"10\":\"ten\",\"2\":\"two\",\"4294967294\":\"max-index\",\"4294967295\":\"not-index\",\"a\":[\"quote\\\"\",\"line\\n\",\"한글\",{\"😀\":\"astral\",\"\":\"private\"}]}";
const FULL_JSON = `{"-1":"minus","01":"leading","1":"one","10":"ten","2":"two","4294967294":"max-index","4294967295":"not-index","a":["quote\\"","line\\n","한글",{"😀":"astral","":"private"}],"envelopeId":"${ID}"}`;
const FULL_HEX = "7b222d31223a226d696e7573222c223031223a226c656164696e67222c2231223a226f6e65222c223130223a2274656e222c2232223a2274776f222c2234323934393637323934223a226d61782d696e646578222c2234323934393637323935223a226e6f742d696e646578222c2261223a5b2271756f74655c22222c226c696e655c6e222c22ed959ceab880222c7b22f09f9880223a2261737472616c222c22ee8080223a2270726976617465227d5d2c22656e76656c6f70654964223a22617474756e6567726170682d656e76656c6f70653a746573743a7368613235363a38616234343163386134643139393132366430643664623038383931303563663630353334663637643061623237313730663838336331353062306538666362227d";
const testArrayConstructor = Array;
const testDefineProperty = Object.defineProperty;
const testGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const testGetPrototypeOf = Object.getPrototypeOf;

interface IntrinsicMutation {
  readonly target: object;
  readonly key: PropertyKey;
  readonly replacement: PropertyDescriptor;
}

interface IntrinsicProbe {
  readonly canonicalJson?: string;
  readonly contentId?: string;
  readonly failures?: readonly unknown[];
  readonly getterCalls?: number;
  readonly rawFailure?: unknown;
}

function valueMutation(target: object, key: PropertyKey): IntrinsicMutation {
  const original = testGetOwnPropertyDescriptor(target, key);
  if (original === undefined || !("value" in original)) {
    throw new Error(`missing value intrinsic ${String(key)}`);
  }
  return {
    target,
    key,
    replacement: {
      ...original,
      value() {
        throw new Error(`poisoned intrinsic ${String(key)}`);
      }
    }
  };
}

function getterMutation(target: object, key: PropertyKey): IntrinsicMutation {
  const original = testGetOwnPropertyDescriptor(target, key);
  if (original === undefined || original.get === undefined) {
    throw new Error(`missing getter intrinsic ${String(key)}`);
  }
  return {
    target,
    key,
    replacement: {
      ...original,
      get() {
        throw new Error(`poisoned intrinsic ${String(key)}`);
      }
    }
  };
}

function runIntrinsicProbe(mutations: readonly IntrinsicMutation[]): IntrinsicProbe {
  const originals = new Array<PropertyDescriptor>(mutations.length);
  const good = fixture();
  const directCycle: Record<string, unknown> = {};
  directCycle.self = directCycle;
  const shared = { value: 1 };
  const alias = { left: shared, right: shared };
  const symbol = { value: 1 };
  testDefineProperty(symbol, Symbol("poison-proof"), {
    configurable: true,
    enumerable: true,
    value: 2,
    writable: true
  });
  let getterCalls = 0;
  const accessor = {};
  testDefineProperty(accessor, "value", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter must not run");
    }
  });
  const bodyOverflow = bodyFixtureAtBytes(
    CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxCanonicalBodyBytes + 1
  );
  const wrongId = `${SPEC.idPrefix}${"0".repeat(64)}`;
  const operations: ReadonlyArray<() => unknown> = [
    () => canonicalizeImmutableEnvelope({ value: undefined }, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope({ value: "\ud800" }, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope(directCycle, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope(alias, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope(symbol, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope(accessor, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope({ value: 1, envelopeId: "bad" }, "external-mutable", SPEC),
    () => canonicalizeImmutableEnvelope(
      { value: 1, envelopeId: wrongId },
      "external-mutable",
      SPEC
    ),
    () => canonicalizeImmutableEnvelope(bodyOverflow, "external-mutable", SPEC)
  ];
  try {
    for (let index = 0; index < mutations.length; index += 1) {
      const mutation = mutations[index];
      if (mutation === undefined) throw new Error("missing intrinsic mutation");
      const original = testGetOwnPropertyDescriptor(mutation.target, mutation.key);
      if (original === undefined) throw new Error("missing intrinsic descriptor");
      originals[index] = original;
      testDefineProperty(mutation.target, mutation.key, mutation.replacement);
    }
    const success = canonicalizeImmutableEnvelope(good, "external-mutable", SPEC);
    const failures = new testArrayConstructor<unknown>(operations.length);
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (operation === undefined) throw new Error("missing intrinsic failure probe");
      try {
        operation();
      } catch (cause) {
        failures[index] = cause;
      }
    }
    return {
      canonicalJson: success.canonicalJson,
      contentId: success.contentId,
      failures,
      getterCalls
    };
  } catch (rawFailure) {
    return { rawFailure };
  } finally {
    for (let index = mutations.length - 1; index >= 0; index -= 1) {
      const mutation = mutations[index];
      const original = originals[index];
      if (mutation !== undefined && original !== undefined) {
        testDefineProperty(mutation.target, mutation.key, original);
      }
    }
  }
}

function expectStableIntrinsicProbe(probe: IntrinsicProbe): void {
  expect(probe.rawFailure).toBeUndefined();
  expect(probe.canonicalJson).toBe(FULL_JSON);
  expect(probe.contentId).toBe(ID);
  expect(probe.getterCalls).toBe(0);
  const expected = [
    ["INVALID_INPUT", "unsupported-value", undefined],
    ["INVALID_INPUT", "unpaired-surrogate", undefined],
    ["INVALID_INPUT", "cycle", undefined],
    ["INVALID_INPUT", "alias", undefined],
    ["INVALID_INPUT", "symbol-key", undefined],
    ["INVALID_INPUT", "accessor-or-missing-descriptor", undefined],
    ["INVALID_INPUT", "malformed-id", undefined],
    ["INTEGRITY_MISMATCH", "content-id-mismatch", undefined],
    ["BUDGET_EXCEEDED", "budget-exceeded", "canonical-body-bytes"]
  ] as const;
  expect(probe.failures).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const failure = probe.failures?.[index];
    const contract = expected[index];
    expect(failure).toBeInstanceOf(CanonicalImmutableEnvelopeError);
    expect((failure as CanonicalImmutableEnvelopeError).code).toBe(contract?.[0]);
    expect((failure as CanonicalImmutableEnvelopeError).details.reason).toBe(contract?.[1]);
    expect((failure as CanonicalImmutableEnvelopeError).details.axis).toBe(contract?.[2]);
  }
}

function fixture(): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  nested[""] = "private";
  nested["😀"] = "astral";
  const value: Record<string, unknown> = {};
  value.a = ["quote\"", "line\n", "한글", nested];
  for (const [key, child] of [
    ["4294967295", "not-index"],
    ["4294967294", "max-index"],
    ["2", "two"],
    ["10", "ten"],
    ["1", "one"],
    ["01", "leading"],
    ["-1", "minus"]
  ] as const) {
    value[key] = child;
  }
  return value;
}

function frozenCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: frozenCopy((value as Record<string, unknown>)[key as string]),
      writable: false
    });
  }
  return Object.freeze(output);
}

function expectError(
  operation: () => unknown,
  code: CanonicalImmutableEnvelopeErrorCode,
  reason?: string
): CanonicalImmutableEnvelopeError {
  try {
    operation();
  } catch (cause) {
    expect(cause).toBeInstanceOf(CanonicalImmutableEnvelopeError);
    const error = cause as CanonicalImmutableEnvelopeError;
    expect(error.code).toBe(code);
    if (reason !== undefined) expect(error.details.reason).toBe(reason);
    expect(Object.isFrozen(error.details)).toBe(true);
    return error;
  }
  throw new Error("expected canonical immutable envelope operation to fail");
}

function assertFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isExtensible(value)).toBe(false);
  expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    expect(descriptor && "value" in descriptor).toBe(true);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(descriptor?.enumerable).toBe(!(Array.isArray(value) && key === "length"));
    if (!(Array.isArray(value) && key === "length")) {
      assertFrozenTree(descriptor?.value);
    }
  }
}

function signedMutable(body: Record<string, unknown>, id = ID): Record<string, unknown> {
  return { ...body, envelopeId: id };
}

function nestedAtDepth(depth: number, leaf: unknown = null): Record<string, unknown> {
  let value = leaf;
  for (let current = 0; current < depth; current += 1) value = [value];
  return { value };
}

function aggregateFixture(target: number): Record<string, unknown> {
  const reserved = Buffer.byteLength("values")
    + Buffer.byteLength(SPEC.idField)
    + Buffer.byteLength(`${SPEC.idPrefix}${"0".repeat(64)}`);
  let remaining = target - reserved;
  const values: string[] = [];
  while (remaining > 0) {
    const length = Math.min(remaining, CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringBytes);
    values.push("a".repeat(length));
    remaining -= length;
  }
  return { values };
}

function bodyFixtureAtBytes(target: number, key = "v"): Record<string, unknown> {
  const values: string[] = [];
  let bytes = Buffer.byteLength(`{"${key}":[]}`);
  while (target - bytes > 32771) {
    values.push("\\".repeat(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringCodeUnits));
    bytes += 32768 + (values.length === 1 ? 2 : 3);
  }
  const overhead = values.length === 0 ? 2 : 3;
  const contentBytes = target - bytes - overhead;
  const slashes = Math.floor(contentBytes / 2);
  const ascii = contentBytes % 2;
  values.push(`${"\\".repeat(slashes)}${"a".repeat(ascii)}`);
  return { [key]: values };
}

function profileInput(profile: CanonicalImmutableEnvelopeProfile): Record<string, unknown> {
  const signed = signedMutable({ nested: { value: ["x"] } });
  return profile === "external-mutable"
    ? signed
    : frozenCopy(signed) as Record<string, unknown>;
}

describe("canonical immutable envelope", () => {
  it("converges unsigned, signed, and independently frozen inputs on the pinned literal", () => {
    expect(Buffer.byteLength(UNSIGNED_JSON)).toBe(178);
    expect(Buffer.byteLength(FULL_JSON)).toBe(291);
    expect(
      createHash("sha256").update(SPEC.hashDomain).update("\0").update(UNSIGNED_JSON).digest("hex")
    ).toBe(DIGEST);

    const unsigned = fixture();
    const signed = signedMutable(fixture());
    const frozen = frozenCopy(signedMutable(fixture()));
    const results = [
      canonicalizeImmutableEnvelope(unsigned, "external-mutable", SPEC),
      canonicalizeImmutableEnvelope(signed, "external-mutable", SPEC),
      canonicalizeImmutableEnvelope(frozen, "attunegraph-frozen", SPEC)
    ];
    for (const result of results) {
      expect(result.canonicalJson).toBe(FULL_JSON);
      expect(result.canonicalByteLength).toBe(291);
      expect(result.contentId).toBe(ID);
      expect(Buffer.from(result.canonicalJson).toString("hex")).toBe(FULL_HEX);
      expect(Object.isFrozen(result)).toBe(true);
      assertFrozenTree(result.envelope);
    }
    expect(results[0]?.envelope).not.toBe(unsigned);
    expect(results[0]?.envelope).not.toBe(results[1]?.envelope);
    expect(results[1]?.envelope).not.toBe(results[2]?.envelope);

    (unsigned.a as unknown[])[0] = "mutated";
    expect(results[0]?.canonicalJson).toBe(FULL_JSON);
    expect((results[0]?.envelope.a as readonly unknown[])[0]).toBe("quote\"");
  });

  it("freezes record-valued length and round-trips adjacent special record keys", () => {
    const source = Object.create(null) as Record<string, unknown>;
    source["prototype"] = { marker: "prototype-data" };
    source["length"] = { child: { marker: "length" } };
    source["constructor"] = { marker: "constructor-data" };
    source["__proto__"] = { marker: "proto-data" };
    source["2"] = "two";
    source["10"] = "ten";
    source["1"] = "one";
    source["01"] = "leading";

    const captured = canonicalizeImmutableEnvelope(source, "external-mutable", SPEC);
    const expected = `{"01":"leading","1":"one","10":"ten","2":"two","__proto__":{"marker":"proto-data"},"constructor":{"marker":"constructor-data"},"envelopeId":"${captured.contentId}","length":{"child":{"marker":"length"}},"prototype":{"marker":"prototype-data"}}`;
    expect(captured.canonicalJson).toBe(expected);
    assertFrozenTree(captured.envelope);

    const lengthDescriptor = Object.getOwnPropertyDescriptor(captured.envelope, "length");
    expect(lengthDescriptor).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false
    });
    const capturedLength = captured.envelope.length as Readonly<Record<string, unknown>>;
    const capturedChild = capturedLength.child as Readonly<Record<string, unknown>>;
    expect(Object.getPrototypeOf(capturedLength)).toBe(null);
    expect(Object.getPrototypeOf(capturedChild)).toBe(null);
    expect(Object.isFrozen(capturedLength)).toBe(true);
    expect(Object.isFrozen(capturedChild)).toBe(true);
    for (const key of ["__proto__", "constructor", "prototype", "01", "1", "10", "2"]) {
      expect(Object.prototype.hasOwnProperty.call(captured.envelope, key)).toBe(true);
    }

    ((source.length as Record<string, unknown>).child as Record<string, unknown>).marker = "mutated";
    expect(capturedChild.marker).toBe("length");

    const readmitted = canonicalizeImmutableEnvelope(captured.envelope, "attunegraph-frozen", SPEC);
    expect(readmitted.canonicalJson).toBe(expected);
    expect(readmitted.canonicalByteLength).toBe(captured.canonicalByteLength);
    expect(readmitted.contentId).toBe(captured.contentId);
    expect(readmitted.envelope).not.toBe(captured.envelope);
    expect(readmitted.envelope.length).not.toBe(captured.envelope.length);
    assertFrozenTree(readmitted.envelope);
  });

  it("sorts raw UTF-16 code units independently of insertion and preserves escaping and NUL", () => {
    const first = { "\uffff": "last", "\0": "nul", "\ue000": "private", "😀": "astral", "01": "text", "1": "index" };
    const second: Record<string, unknown> = {};
    for (const key of Object.keys(first).reverse()) second[key] = first[key as keyof typeof first];
    const left = canonicalizeImmutableEnvelope(first, "external-mutable", {
      ...SPEC,
      hashDomain: "domain/nul-order"
    });
    const right = canonicalizeImmutableEnvelope(second, "external-mutable", {
      ...SPEC,
      hashDomain: "domain/nul-order"
    });
    expect(left.canonicalJson).toBe(right.canonicalJson);
    expect(left.canonicalJson.indexOf("\"01\"")).toBeLessThan(left.canonicalJson.indexOf("\"1\""));
    expect(left.canonicalJson).toContain("\"\\u0000\":\"nul\"");
  });

  it("keeps bytes and typed failures stable after individual and combined intrinsic poisoning", () => {
    const typedArrayPrototype = testGetPrototypeOf(Uint8Array.prototype);
    const hashPrototype = testGetPrototypeOf(createHash("sha256"));
    if (typedArrayPrototype === null || hashPrototype === null) {
      throw new Error("required intrinsic prototype unavailable");
    }
    const mutations: IntrinsicMutation[] = [
      valueMutation(Array.prototype, "sort"),
      valueMutation(Array.prototype, "some"),
      valueMutation(Array.prototype, "includes"),
      valueMutation(Array.prototype, "filter"),
      valueMutation(Array.prototype, Symbol.iterator),
      valueMutation(String.prototype, "charCodeAt"),
      valueMutation(String.prototype, "replaceAll"),
      valueMutation(String.prototype, "startsWith"),
      valueMutation(String.prototype, "slice"),
      valueMutation(String.prototype, "repeat"),
      valueMutation(RegExp.prototype, "test"),
      valueMutation(WeakSet.prototype, "add"),
      valueMutation(WeakSet.prototype, "has"),
      valueMutation(WeakSet.prototype, "delete"),
      valueMutation(Map.prototype, "get"),
      valueMutation(Map.prototype, "has"),
      valueMutation(Map.prototype, "set"),
      valueMutation(TextEncoder.prototype, "encode"),
      valueMutation(hashPrototype, "update"),
      valueMutation(hashPrototype, "digest"),
      getterMutation(typedArrayPrototype, "byteLength"),
      valueMutation(Array, "isArray"),
      valueMutation(JSON, "stringify"),
      valueMutation(Number, "isFinite"),
      valueMutation(Number, "isInteger"),
      valueMutation(Number, "isSafeInteger"),
      valueMutation(Object, "create"),
      valueMutation(Object, "defineProperty"),
      valueMutation(Object, "freeze"),
      valueMutation(Object, "isFrozen"),
      valueMutation(Object, "is"),
      valueMutation(Reflect, "apply"),
      valueMutation(Reflect, "getOwnPropertyDescriptor"),
      valueMutation(Reflect, "getPrototypeOf"),
      valueMutation(Reflect, "isExtensible"),
      valueMutation(Reflect, "ownKeys"),
      valueMutation(globalThis, "Array"),
      valueMutation(globalThis, "Map"),
      valueMutation(globalThis, "WeakSet"),
      valueMutation(globalThis, "Number"),
      valueMutation(globalThis, "String"),
      valueMutation(globalThis, "TextEncoder")
    ];
    for (const name of [
      "isProxy",
      "isAnyArrayBuffer",
      "isArgumentsObject",
      "isArrayBufferView",
      "isBoxedPrimitive",
      "isCryptoKey",
      "isDate",
      "isExternal",
      "isGeneratorObject",
      "isKeyObject",
      "isMap",
      "isMapIterator",
      "isModuleNamespaceObject",
      "isNativeError",
      "isPromise",
      "isRegExp",
      "isSet",
      "isSetIterator",
      "isWeakMap",
      "isWeakSet"
    ] as const) {
      const descriptor = testGetOwnPropertyDescriptor(types, name);
      if (descriptor?.configurable === true || descriptor?.writable === true) {
        mutations[mutations.length] = valueMutation(types, name);
      }
    }

    for (let index = 0; index < mutations.length; index += 1) {
      const mutation = mutations[index];
      if (mutation === undefined) throw new Error("missing intrinsic mutation");
      expectStableIntrinsicProbe(runIntrinsicProbe([mutation]));
    }
    expectStableIntrinsicProbe(runIntrinsicProbe(mutations));

    expect([2, 1].sort()).toEqual([1, 2]);
    expect("a".charCodeAt(0)).toBe(97);
    expect(Reflect.ownKeys({ restored: true })).toEqual(["restored"]);
    expect(types.isProxy({})).toBe(false);
  });

  it("enforces every constructible descriptor flag and uniform container profile", () => {
    for (const profile of ["external-mutable", "attunegraph-frozen"] as const) {
      const baseline = profileInput(profile);
      const expectedWritable = profile === "external-mutable";
      const wrongField = baseline.nested as Record<string, unknown>;
      if (profile === "external-mutable") {
        Object.defineProperty(wrongField, "value", {
          configurable: true,
          enumerable: true,
          value: wrongField.value,
          writable: false
        });
      } else {
        const mutable = Object.assign(Object.create(null), signedMutable({ nested: { value: ["x"] } })) as Record<string, unknown>;
        Object.preventExtensions(mutable);
        expectError(
          () => canonicalizeImmutableEnvelope(mutable, profile, SPEC),
          "PROFILE_MISMATCH",
          "descriptor-flags"
        );
        continue;
      }
      const error = expectError(
        () => canonicalizeImmutableEnvelope(baseline, profile, SPEC),
        "PROFILE_MISMATCH",
        "descriptor-flags"
      );
      expect(error.details.path).toBe("/nested/value");
      expect(expectedWritable).toBe(profile === "external-mutable");
    }

    const mutations: PropertyDescriptor[] = [
      { configurable: false, enumerable: true, value: 1, writable: true },
      { configurable: true, enumerable: false, value: 1, writable: true },
      { configurable: true, enumerable: true, value: 1, writable: false }
    ];
    for (const descriptor of mutations) {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "x", descriptor);
      expectError(() => canonicalizeImmutableEnvelope(value, "external-mutable", SPEC), "PROFILE_MISMATCH");
    }

    const sealed = Object.seal({ x: 1 });
    expectError(() => canonicalizeImmutableEnvelope(sealed, "external-mutable", SPEC), "PROFILE_MISMATCH");
    const shallow = Object.freeze(Object.assign(Object.create(null), {
      envelopeId: ID,
      child: { x: 1 }
    }));
    expectError(() => canonicalizeImmutableEnvelope(shallow, "attunegraph-frozen", SPEC), "INVALID_INPUT");
    const mixed = frozenCopy({ envelopeId: ID, child: { x: 1 } }) as Record<string, unknown>;
    const thawedChild = Object.assign(Object.create(null), { x: 1 }) as Record<string, unknown>;
    const mixedRoot = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(mixedRoot, {
      envelopeId: { configurable: false, enumerable: true, value: ID, writable: false },
      child: { configurable: false, enumerable: true, value: thawedChild, writable: false }
    });
    Object.preventExtensions(mixedRoot);
    expectError(() => canonicalizeImmutableEnvelope(mixedRoot, "attunegraph-frozen", SPEC), "PROFILE_MISMATCH");
    expect(mixed.child).toBeDefined();

    const array = ["x"];
    const length = Object.getOwnPropertyDescriptor(array, "length");
    expect(length?.enumerable).toBe(false);
    expect(length?.configurable).toBe(false);
    Object.defineProperty(array, "length", { writable: false });
    expectError(() => canonicalizeImmutableEnvelope({ array }, "external-mutable", SPEC), "PROFILE_MISMATCH");
  });

  it("rejects each single-flag mutation on record fields, array indices, and array length", () => {
    const flagMutations = {
      "external-mutable": [
        { configurable: false, enumerable: true, writable: true },
        { configurable: true, enumerable: false, writable: true },
        { configurable: true, enumerable: true, writable: false }
      ],
      "attunegraph-frozen": [
        { configurable: true, enumerable: true, writable: false },
        { configurable: false, enumerable: false, writable: false },
        { configurable: false, enumerable: true, writable: true }
      ]
    } as const;

    for (const profile of ["external-mutable", "attunegraph-frozen"] as const) {
      for (const flags of flagMutations[profile]) {
        const root = profile === "external-mutable"
          ? {}
          : Object.create(null) as Record<string, unknown>;
        Object.defineProperty(root, "envelopeId", {
          configurable: profile === "external-mutable",
          enumerable: true,
          value: ID,
          writable: profile === "external-mutable"
        });
        Object.defineProperty(root, "x", { ...flags, value: 1 });
        if (profile === "attunegraph-frozen") Object.preventExtensions(root);
        expectError(
          () => canonicalizeImmutableEnvelope(root, profile, SPEC),
          "PROFILE_MISMATCH",
          "descriptor-flags"
        );

        const array = ["x"];
        Object.defineProperty(array, "0", { ...flags, value: "x" });
        if (profile === "attunegraph-frozen") {
          Object.defineProperty(array, "length", { writable: false });
          Object.preventExtensions(array);
        }
        const arrayRoot = Object.create(profile === "external-mutable" ? Object.prototype : null) as Record<string, unknown>;
        Object.defineProperties(arrayRoot, {
          envelopeId: {
            configurable: profile === "external-mutable",
            enumerable: true,
            value: ID,
            writable: profile === "external-mutable"
          },
          array: {
            configurable: profile === "external-mutable",
            enumerable: true,
            value: array,
            writable: profile === "external-mutable"
          }
        });
        if (profile === "attunegraph-frozen") Object.preventExtensions(arrayRoot);
        expectError(
          () => canonicalizeImmutableEnvelope(arrayRoot, profile, SPEC),
          "PROFILE_MISMATCH",
          "descriptor-flags"
        );
      }

      const lengthArray = ["x"];
      Object.defineProperty(lengthArray, "length", {
        writable: profile !== "external-mutable"
      });
      if (profile === "attunegraph-frozen") {
        Object.defineProperty(lengthArray, "0", {
          configurable: false,
          enumerable: true,
          value: "x",
          writable: false
        });
        Object.preventExtensions(lengthArray);
      }
      const root = profile === "external-mutable"
        ? { array: lengthArray, envelopeId: ID }
        : Object.create(null) as Record<string, unknown>;
      if (profile === "attunegraph-frozen") {
        Object.defineProperties(root, {
          envelopeId: { configurable: false, enumerable: true, value: ID, writable: false },
          array: { configurable: false, enumerable: true, value: lengthArray, writable: false }
        });
        Object.preventExtensions(root);
      }
      expectError(
        () => canonicalizeImmutableEnvelope(root, profile, SPEC),
        "PROFILE_MISMATCH",
        "descriptor-flags"
      );
    }
  });

  it("rejects accessors, symbols, sparse arrays, extras, and poison getters without invocation", () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "x", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("poison");
      }
    });
    expectError(() => canonicalizeImmutableEnvelope(accessor, "external-mutable", SPEC), "INVALID_INPUT");
    expect(getterCalls).toBe(0);

    const symbol = { x: 1 };
    Object.defineProperty(symbol, Symbol("extra"), { configurable: true, enumerable: true, value: 2, writable: true });
    expectError(() => canonicalizeImmutableEnvelope(symbol, "external-mutable", SPEC), "INVALID_INPUT", "symbol-key");
    expectError(() => canonicalizeImmutableEnvelope({ array: new Array(1) }, "external-mutable", SPEC), "INVALID_INPUT", "sparse-array");
    const extra = ["x"] as unknown[] & { extra?: number };
    extra.extra = 1;
    expectError(() => canonicalizeImmutableEnvelope({ extra }, "external-mutable", SPEC), "INVALID_INPUT", "array-extra-key");
  });

  it("rejects ordinary, nested, and revoked proxies before any trap executes", () => {
    let traps = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        traps += 1;
        throw new Error("trap");
      },
      ownKeys() {
        traps += 1;
        throw new Error("trap");
      }
    });
    expect(types.isProxy(proxy)).toBe(true);
    expectError(() => canonicalizeImmutableEnvelope(proxy, "external-mutable", SPEC), "INVALID_INPUT", "proxy");
    expectError(() => canonicalizeImmutableEnvelope({ proxy }, "external-mutable", SPEC), "INVALID_INPUT", "proxy");
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expectError(() => canonicalizeImmutableEnvelope(revocable.proxy, "external-mutable", SPEC), "INVALID_INPUT", "proxy");
    expect(traps).toBe(0);
  });

  it("distinguishes cycles from completed aliases", () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;
    expectError(() => canonicalizeImmutableEnvelope(direct, "external-mutable", SPEC), "INVALID_INPUT", "cycle");
    const left: Record<string, unknown> = {};
    const right: Record<string, unknown> = { left };
    left.right = right;
    expectError(() => canonicalizeImmutableEnvelope(left, "external-mutable", SPEC), "INVALID_INPUT", "cycle");
    const child = { x: 1 };
    expectError(
      () => canonicalizeImmutableEnvelope({ first: child, second: child }, "external-mutable", SPEC),
      "INVALID_INPUT",
      "alias"
    );
  });

  it("rejects unsupported values, prototypes, numbers, surrogates, and null-prototype built-in brands", () => {
    for (const value of [undefined, 1n, Symbol("x"), () => undefined]) {
      expectError(() => canonicalizeImmutableEnvelope({ value }, "external-mutable", SPEC), "INVALID_INPUT");
    }
    for (const value of [NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1]) {
      expectError(() => canonicalizeImmutableEnvelope({ value }, "external-mutable", SPEC), "INVALID_INPUT");
    }
    expectError(() => canonicalizeImmutableEnvelope({ value: "\ud800" }, "external-mutable", SPEC), "INVALID_INPUT", "unpaired-surrogate");
    expectError(() => canonicalizeImmutableEnvelope(new (class Example { x = 1; })(), "external-mutable", SPEC), "INVALID_INPUT", "unsupported-prototype");

    const brands: object[] = [
      new Date(),
      new Map(),
      new Set(),
      new Number(1),
      new Uint8Array(0),
      Promise.resolve()
    ];
    for (const value of brands) {
      Object.setPrototypeOf(value, null);
      expectError(() => canonicalizeImmutableEnvelope(value, "external-mutable", SPEC), "INVALID_INPUT", "unsupported-brand");
      Object.freeze(value);
      expectError(
        () => canonicalizeImmutableEnvelope(
          Object.freeze(Object.assign(Object.create(null), { envelopeId: ID, value })),
          "attunegraph-frozen",
          SPEC
        ),
        "INVALID_INPUT"
      );
    }
  });

  it("accepts a prototype-spoofed user class only as an own-data structural snapshot", () => {
    class Hidden {
      #secret = "not-observable";
      visible = "observable";
      reveal(): string {
        return this.#secret;
      }
    }
    const source = new Hidden();
    Object.setPrototypeOf(source, null);
    const result = canonicalizeImmutableEnvelope(source, "external-mutable", SPEC);
    expect(result.canonicalJson).toContain("\"visible\":\"observable\"");
    expect(result.canonicalJson).not.toContain("not-observable");
    expect(Object.getPrototypeOf(result.envelope)).toBe(null);
  });

  it("checks depth before touching an over-depth proxy", () => {
    let traps = 0;
    const poison = new Proxy({}, {
      ownKeys() {
        traps += 1;
        throw new Error("must not run");
      }
    });
    let value: unknown = poison;
    for (let depth = 0; depth < CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDepth; depth += 1) {
      value = [value];
    }
    const error = expectError(
      () => canonicalizeImmutableEnvelope({ value }, "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("depth");
    expect(error.details.actual).toBe(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDepth + 1);
    expect(traps).toBe(0);
  });

  it("enforces string code-unit, byte, descriptor, and bounded-path budgets inclusively", () => {
    const codeUnits = "a".repeat(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringCodeUnits - 1);
    expect(() => canonicalizeImmutableEnvelope({ value: codeUnits }, "external-mutable", SPEC)).not.toThrow();
    const exactCodeUnits = `${codeUnits}a`;
    expect(() => canonicalizeImmutableEnvelope({ value: exactCodeUnits }, "external-mutable", SPEC)).not.toThrow();
    let error = expectError(
      () => canonicalizeImmutableEnvelope({ value: `${exactCodeUnits}a` }, "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("string-code-units");

    const byteBase = "가".repeat(5461);
    expect(Buffer.byteLength(byteBase)).toBe(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringBytes - 1);
    expect(() => canonicalizeImmutableEnvelope({ value: byteBase }, "external-mutable", SPEC)).not.toThrow();
    const exactBytes = `${byteBase}a`;
    expect(Buffer.byteLength(exactBytes)).toBe(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringBytes);
    expect(() => canonicalizeImmutableEnvelope({ value: exactBytes }, "external-mutable", SPEC)).not.toThrow();
    error = expectError(
      () => canonicalizeImmutableEnvelope({ value: `${exactBytes}a` }, "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("string-bytes");

    const descriptorExact = new Array(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDescriptors - 4).fill(null);
    const descriptorBelow = descriptorExact.slice(1);
    expect(() => canonicalizeImmutableEnvelope({ many: descriptorBelow }, "external-mutable", SPEC)).not.toThrow();
    expect(() => canonicalizeImmutableEnvelope({ many: descriptorExact }, "external-mutable", SPEC)).not.toThrow();
    descriptorExact.push(null);
    error = expectError(
      () => canonicalizeImmutableEnvelope({ many: descriptorExact }, "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("descriptors");

    const longKey = "k".repeat(510);
    error = expectError(
      () => canonicalizeImmutableEnvelope({ [longKey]: { again: undefined } }, "external-mutable", SPEC),
      "INVALID_INPUT"
    );
    expect(error.details.path).toBe("<path-too-long>");
  });

  it("enforces limit - 1, exact limit, and limit + 1 for depth, aggregate strings, and both encodings", () => {
    const depthLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDepth;
    expect(() => canonicalizeImmutableEnvelope(nestedAtDepth(depthLimit - 2), "external-mutable", SPEC)).not.toThrow();
    expect(() => canonicalizeImmutableEnvelope(nestedAtDepth(depthLimit - 1), "external-mutable", SPEC)).not.toThrow();
    let error = expectError(
      () => canonicalizeImmutableEnvelope(nestedAtDepth(depthLimit), "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("depth");

    const aggregateLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxAggregateStringBytes;
    expect(() => canonicalizeImmutableEnvelope(aggregateFixture(aggregateLimit - 1), "external-mutable", SPEC)).not.toThrow();
    expect(() => canonicalizeImmutableEnvelope(aggregateFixture(aggregateLimit), "external-mutable", SPEC)).not.toThrow();
    error = expectError(
      () => canonicalizeImmutableEnvelope(aggregateFixture(aggregateLimit + 1), "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("aggregate-string-bytes");

    const bodyLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxCanonicalBodyBytes;
    expect(() => canonicalizeImmutableEnvelope(bodyFixtureAtBytes(bodyLimit - 1), "external-mutable", SPEC)).not.toThrow();
    expect(() => canonicalizeImmutableEnvelope(bodyFixtureAtBytes(bodyLimit), "external-mutable", SPEC)).not.toThrow();
    error = expectError(
      () => canonicalizeImmutableEnvelope(bodyFixtureAtBytes(bodyLimit + 1), "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("canonical-body-bytes");
    expect(error.details.actual).toBe(bodyLimit + 1);

    const fullSpec = {
      hashDomain: "full-envelope-boundary",
      idField: "a".repeat(64),
      idPrefix: "\"".repeat(128)
    };
    const fullAddition = Buffer.byteLength(JSON.stringify(fullSpec.idField))
      + 1
      + Buffer.byteLength(JSON.stringify(`${fullSpec.idPrefix}${"0".repeat(64)}`))
      + 1;
    const fullLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxEnvelopeBytes;
    for (const delta of [-1, 0] as const) {
      const bodyBytes = fullLimit - fullAddition + delta;
      const result = canonicalizeImmutableEnvelope(bodyFixtureAtBytes(bodyBytes, "z"), "external-mutable", fullSpec);
      expect(result.canonicalByteLength).toBe(fullLimit + delta);
    }
    const overflowingBodyBytes = fullLimit - fullAddition + 1;
    error = expectError(
      () => canonicalizeImmutableEnvelope(
        {
          ...bodyFixtureAtBytes(overflowingBodyBytes, "z"),
          [fullSpec.idField]: `${fullSpec.idPrefix}${"f".repeat(64)}`
        },
        "external-mutable",
        fullSpec
      ),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("full-envelope-bytes");
    expect(error.details.actual).toBe(fullLimit + 1);
  });

  it("keeps the default helper byte-identical while allowing only internal byte ceilings to change", () => {
    const publicResult = canonicalizeImmutableEnvelope(
      fixture(),
      "external-mutable",
      SPEC
    );
    const internalResult = canonicalizeImmutableEnvelopeForInternalUse(
      fixture(),
      "external-mutable",
      SPEC,
      {
        maxCanonicalBodyBytes: 1_048_256,
        maxEnvelopeBytes: 1_048_576
      }
    );
    expect(internalResult.canonicalJson).toBe(publicResult.canonicalJson);
    expect(internalResult.canonicalByteLength).toBe(
      publicResult.canonicalByteLength
    );
    expect(internalResult.contentId).toBe(publicResult.contentId);
    expect(Buffer.from(internalResult.canonicalJson).toString("hex")).toBe(
      Buffer.from(publicResult.canonicalJson).toString("hex")
    );

    const bodyLimits = {
      maxCanonicalBodyBytes: 2_048,
      maxEnvelopeBytes: 4_096
    };
    expect(() => canonicalizeImmutableEnvelopeForInternalUse(
      bodyFixtureAtBytes(bodyLimits.maxCanonicalBodyBytes),
      "external-mutable",
      SPEC,
      bodyLimits
    )).not.toThrow();
    const bodyError = expectError(
      () => canonicalizeImmutableEnvelopeForInternalUse(
        bodyFixtureAtBytes(bodyLimits.maxCanonicalBodyBytes + 1),
        "external-mutable",
        SPEC,
        bodyLimits
      ),
      "BUDGET_EXCEEDED"
    );
    expect(bodyError.details.axis).toBe("canonical-body-bytes");
    expect(bodyError.details.limit).toBe(bodyLimits.maxCanonicalBodyBytes);

    const fullSpec = {
      hashDomain: "internal-full-envelope-boundary",
      idField: "a".repeat(64),
      idPrefix: "\"".repeat(128)
    };
    const fullAddition = Buffer.byteLength(JSON.stringify(fullSpec.idField))
      + 1
      + Buffer.byteLength(JSON.stringify(`${fullSpec.idPrefix}${"0".repeat(64)}`))
      + 1;
    const fullLimits = {
      maxCanonicalBodyBytes: 4_096,
      maxEnvelopeBytes: 4_096
    };
    const exactFull = canonicalizeImmutableEnvelopeForInternalUse(
      bodyFixtureAtBytes(fullLimits.maxEnvelopeBytes - fullAddition, "z"),
      "external-mutable",
      fullSpec,
      fullLimits
    );
    expect(exactFull.canonicalByteLength).toBe(fullLimits.maxEnvelopeBytes);
    const fullError = expectError(
      () => canonicalizeImmutableEnvelopeForInternalUse(
        bodyFixtureAtBytes(
          fullLimits.maxEnvelopeBytes - fullAddition + 1,
          "z"
        ),
        "external-mutable",
        fullSpec,
        fullLimits
      ),
      "BUDGET_EXCEEDED"
    );
    expect(fullError.details.axis).toBe("full-envelope-bytes");
    expect(fullError.details.limit).toBe(fullLimits.maxEnvelopeBytes);
  });

  it("mints an exact frozen unsigned root only through the package-private path", () => {
    const frozenUnsigned = frozenCopy(fixture());
    expectError(
      () => canonicalizeImmutableEnvelope(
        frozenUnsigned,
        "attunegraph-frozen",
        SPEC
      ),
      "INVALID_INPUT",
      "missing-id"
    );
    const expected = canonicalizeImmutableEnvelope(
      fixture(),
      "external-mutable",
      SPEC
    );
    const minted =
      mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
        frozenUnsigned,
        SPEC
      );
    expectError(
      () => mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
        frozenCopy(signedMutable(fixture())),
        SPEC
      ),
      "INVALID_INPUT",
      "expected-unsigned-root"
    );
    expect(minted.contentId).toBe(expected.contentId);
    expect(minted.canonicalJson).toBe(expected.canonicalJson);
    expect(minted.canonicalByteLength).toBe(expected.canonicalByteLength);
    expect(Buffer.from(minted.canonicalJson).toString("hex")).toBe(
      Buffer.from(expected.canonicalJson).toString("hex")
    );
    assertFrozenTree(minted.envelope);
  });

  it("rejects hostile or invalid internal byte limits without invoking getters or proxy traps", () => {
    let getterCalls = 0;
    const accessorLimits = {
      maxEnvelopeBytes: 2_048
    };
    Object.defineProperty(accessorLimits, "maxCanonicalBodyBytes", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not run");
      }
    });
    let proxyTraps = 0;
    const proxyLimits = new Proxy({
      maxCanonicalBodyBytes: 1_024,
      maxEnvelopeBytes: 2_048
    }, {
      ownKeys() {
        proxyTraps += 1;
        throw new Error("must not run");
      }
    });
    const symbolLimits = {
      maxCanonicalBodyBytes: 1_024,
      maxEnvelopeBytes: 2_048,
      [Symbol("unknown")]: true
    };
    const invalidLimits: readonly unknown[] = [
      null,
      [],
      new Date(),
      proxyLimits,
      accessorLimits,
      symbolLimits,
      { maxCanonicalBodyBytes: 1_024 },
      {
        maxCanonicalBodyBytes: 1_024,
        maxEnvelopeBytes: 2_048,
        unknown: true
      },
      { maxCanonicalBodyBytes: 0, maxEnvelopeBytes: 2_048 },
      { maxCanonicalBodyBytes: 1.5, maxEnvelopeBytes: 2_048 },
      { maxCanonicalBodyBytes: 2_049, maxEnvelopeBytes: 2_048 },
      { maxCanonicalBodyBytes: 1_024, maxEnvelopeBytes: 2_097_153 },
      {
        maxCanonicalBodyBytes: Number.MAX_SAFE_INTEGER + 1,
        maxEnvelopeBytes: Number.MAX_SAFE_INTEGER + 1
      }
    ];
    for (const limits of invalidLimits) {
      expectError(
        () => canonicalizeImmutableEnvelopeForInternalUse(
          fixture(),
          "external-mutable",
          SPEC,
          limits as never
        ),
        "INVALID_CONTRACT",
        "invalid-byte-limits"
      );
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
    expect(() => canonicalizeImmutableEnvelopeForInternalUse(
      fixture(),
      "external-mutable",
      SPEC,
      {
        maxCanonicalBodyBytes: 2_097_152,
        maxEnvelopeBytes: 2_097_152
      }
    )).not.toThrow();
  });

  it("does not relax non-byte admission checks under the maximum internal ceilings", () => {
    const limits = {
      maxCanonicalBodyBytes: 2_097_152,
      maxEnvelopeBytes: 2_097_152
    };
    const run = (value: unknown): unknown =>
      canonicalizeImmutableEnvelopeForInternalUse(
        value,
        "external-mutable",
        SPEC,
        limits
      );
    let error = expectError(
      () => run(nestedAtDepth(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDepth)),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("depth");
    error = expectError(
      () => run(aggregateFixture(
        CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxAggregateStringBytes + 1
      )),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("aggregate-string-bytes");
    error = expectError(
      () => run({
        value: "a".repeat(
          CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringCodeUnits + 1
        )
      }),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("string-code-units");
    error = expectError(
      () => run({ value: "가".repeat(5_462) }),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("string-bytes");

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const shared = { value: 1 };
    const accessor = {};
    let getterCalls = 0;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not run");
      }
    });
    const sparse = new Array(1);
    for (const [value, reason] of [
      [cycle, "cycle"],
      [{ left: shared, right: shared }, "alias"],
      [accessor, "accessor-or-missing-descriptor"],
      [{ sparse }, "sparse-array"],
      [{ value: "\ud800" }, "unpaired-surrogate"],
      [{ value: -0 }, "unsupported-number"],
      [{ value: Number.POSITIVE_INFINITY }, "unsupported-number"]
    ] as const) {
      expectError(() => run(value), "INVALID_INPUT", reason);
    }
    expect(getterCalls).toBe(0);
  });

  it("keeps the neutral root export surface exact", async () => {
    const root = await import("@attunegraph/core");
    expect(Object.keys(root).sort()).toEqual([
      "ACTIVATION_PREDICATES",
      "AttuneGraphDataError",
      "AttuneGraphError",
      "GRAPH_ASSERTION_SOURCE_NAMESPACE",
      "GRAPH_DERIVATION_KINDS",
      "GRAPH_DIRECTIONS",
      "GRAPH_EPISTEMIC_CLASSES",
      "GRAPH_NODE_KINDS",
      "GRAPH_PREDICATES",
      "InMemoryAttuneGraphDataStore",
      "MAX_ACTIVATION_ESTIMATED_TOKENS",
      "MAX_GRAPH_APPEND_BATCH_ASSERTIONS",
      "MAX_GRAPH_ASSERTION_SOURCE_REFS",
      "MAX_GRAPH_QUERY_ASSERTIONS",
      "MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS",
      "MAX_GRAPH_QUERY_DEPTH",
      "MAX_GRAPH_QUERY_SEEDS",
      "MAX_GRAPH_QUERY_VISITED_REFS",
      "compileActivationSubgraph",
      "createAttuneGraphEngine",
      "openAttuneGraph"
    ]);
    const privateSubpath = "@attunegraph/core/canonical-immutable-envelope";
    await expect(import(privateSubpath)).rejects.toThrow(/not exported/u);
  });

  it("enforces string code-unit budget at the exact inclusive edge", () => {
    const codeUnits = "a".repeat(CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringCodeUnits);
    expect(() => canonicalizeImmutableEnvelope({ value: codeUnits }, "external-mutable", SPEC)).not.toThrow();
    const error = expectError(
      () => canonicalizeImmutableEnvelope({ value: `${codeUnits}a` }, "external-mutable", SPEC),
      "BUDGET_EXCEEDED"
    );
    expect(error.details.axis).toBe("string-code-units");
  });

  it("applies missing, malformed, full-budget, and wrong-ID precedence", () => {
    expectError(
      () => canonicalizeImmutableEnvelope(frozenCopy({ value: 1 }), "attunegraph-frozen", SPEC),
      "INVALID_INPUT",
      "missing-id"
    );
    expectError(
      () => canonicalizeImmutableEnvelope({ value: 1, envelopeId: "bad" }, "external-mutable", SPEC),
      "INVALID_INPUT",
      "malformed-id"
    );
    expectError(
      () => canonicalizeImmutableEnvelope(
        { value: 1, envelopeId: `${SPEC.idPrefix}${"0".repeat(64)}` },
        "external-mutable",
        SPEC
      ),
      "INTEGRITY_MISMATCH",
      "content-id-mismatch"
    );
  });

  it("validates static spec/profile contracts and exposes no mutable byte container", () => {
    for (const spec of [
      { ...SPEC, hashDomain: "" },
      { ...SPEC, hashDomain: "bad\0domain" },
      { ...SPEC, idField: "bad-field" },
      { ...SPEC, idPrefix: "\n" }
    ]) {
      expectError(() => canonicalizeImmutableEnvelope({}, "external-mutable", spec), "INVALID_CONTRACT");
    }
    expectError(
      () => canonicalizeImmutableEnvelope({}, "invalid" as CanonicalImmutableEnvelopeProfile, SPEC),
      "INVALID_CONTRACT"
    );
    const result = canonicalizeImmutableEnvelope({}, "external-mutable", SPEC);
    expect(result.canonicalJson).toEqual(expect.any(String));
    expect(result.contentId).toEqual(expect.any(String));
    expect(Object.values(result).some((value) => ArrayBuffer.isView(value))).toBe(false);
  });
});
