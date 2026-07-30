import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

export const CANONICAL_IMMUTABLE_ENVELOPE_LIMITS = Object.freeze({
  maxDepth: 12,
  maxDescriptors: 32768,
  maxStringCodeUnits: 16384,
  maxStringBytes: 16384,
  maxAggregateStringBytes: 1000000,
  maxCanonicalBodyBytes: 1048256,
  maxEnvelopeBytes: 1048576,
  maxErrorPathBytes: 512,
  maxHashDomainBytes: 128,
  maxIdFieldBytes: 64,
  maxIdPrefixBytes: 128
} as const);

export type CanonicalImmutableEnvelopeProfile =
  | "external-mutable"
  | "attunegraph-frozen";

export type CanonicalImmutableEnvelopeErrorCode =
  | "INVALID_CONTRACT"
  | "INVALID_INPUT"
  | "PROFILE_MISMATCH"
  | "BUDGET_EXCEEDED"
  | "INTEGRITY_MISMATCH"
  | "POSTCONDITION_FAILED";

type ErrorPhase =
  | "contract"
  | "inspect"
  | "encode"
  | "integrity"
  | "freeze"
  | "postverify";

type BudgetAxis =
  | "depth"
  | "descriptors"
  | "string-code-units"
  | "string-bytes"
  | "aggregate-string-bytes"
  | "canonical-body-bytes"
  | "full-envelope-bytes";

export interface CanonicalImmutableEnvelopeSpec {
  readonly hashDomain: string;
  readonly idField: string;
  readonly idPrefix: string;
}

export interface CanonicalImmutableEnvelopeResult {
  readonly envelope: Readonly<Record<string, unknown>>;
  /** Canonical JSON of the full signed envelope. */
  readonly canonicalJson: string;
  /** UTF-8 byte length of canonicalJson. */
  readonly canonicalByteLength: number;
  readonly contentId: string;
}

export interface CanonicalImmutableEnvelopeByteLimits {
  readonly maxCanonicalBodyBytes: number;
  readonly maxEnvelopeBytes: number;
}

export class CanonicalImmutableEnvelopeError extends Error {
  readonly code: CanonicalImmutableEnvelopeErrorCode;
  readonly details: Readonly<{
    readonly phase: ErrorPhase;
    readonly reason: string;
    readonly path: string;
    readonly axis?: BudgetAxis;
    readonly actual?: number;
    readonly limit?: number;
  }>;

  constructor(
    code: CanonicalImmutableEnvelopeErrorCode,
    message: string,
    details: CanonicalImmutableEnvelopeError["details"],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CanonicalImmutableEnvelopeError";
    this.code = code;
    this.details = objectFreeze({ ...details });
  }
}

type JsonPrimitive = null | boolean | number | string;
interface DetachedArray extends Array<DetachedValue> {}
interface DetachedRecord {
  [key: string]: DetachedValue;
}
type DetachedValue = JsonPrimitive | DetachedArray | DetachedRecord;

interface InspectionState {
  readonly profile: CanonicalImmutableEnvelopeProfile;
  readonly spec: CanonicalImmutableEnvelopeSpec;
  readonly allowMissingFrozenRootId: boolean;
  readonly allowFrozenPlainRecordPrototype: boolean;
  readonly active: WeakSet<object>;
  readonly seen: WeakSet<object>;
  descriptors: number;
  aggregateStringBytes: number;
  suppliedId?: string;
}

const arrayConstructor = Array;
const arrayIsArray = Array.isArray;
const canonicalImmutableEnvelopeErrorPrototype = CanonicalImmutableEnvelopeError.prototype;
const jsonStringify = JSON.stringify;
const mapConstructor = Map;
const numberConstructor = Number;
const numberIsFinite = Number.isFinite;
const numberIsInteger = Number.isInteger;
const numberIsSafeInteger = Number.isSafeInteger;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectIsFrozen = Object.isFrozen;
const objectIs = Object.is;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectIsExtensible = Reflect.isExtensible;
const reflectOwnKeys = Reflect.ownKeys;
const regExpTest = RegExp.prototype.test;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringConstructor = String;
const stringRepeat = String.prototype.repeat;
const stringReplaceAll = String.prototype.replaceAll;
const stringSlice = String.prototype.slice;
const stringStartsWith = String.prototype.startsWith;
const textEncoder = new TextEncoder();
const textEncode = TextEncoder.prototype.encode;
const reflectApply = Reflect.apply;
const weakSetConstructor = WeakSet;
const weakSetAdd = WeakSet.prototype.add;
const weakSetDelete = WeakSet.prototype.delete;
const weakSetHas = WeakSet.prototype.has;
const DEFAULT_CANONICAL_BYTE_LIMITS =
  objectFreeze<CanonicalImmutableEnvelopeByteLimits>({
    maxCanonicalBodyBytes: 1_048_256,
    maxEnvelopeBytes: 1_048_576
  });
const MAX_INTERNAL_CANONICAL_BYTE_LIMIT = 2_097_152;
const mapGet = Map.prototype.get;
const mapHas = Map.prototype.has;
const mapSet = Map.prototype.set;
const hashUpdate = createHash("sha256").update;
const hashDigest = createHash("sha256").digest;
const typedArrayPrototype = reflectGetPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = typedArrayPrototype === null
  ? undefined
  : reflectGetOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

const isProxy = nodeTypes.isProxy;
const brandPredicates = Object.freeze([
  nodeTypes.isAnyArrayBuffer,
  nodeTypes.isArgumentsObject,
  nodeTypes.isArrayBufferView,
  nodeTypes.isBoxedPrimitive,
  nodeTypes.isCryptoKey,
  nodeTypes.isDate,
  nodeTypes.isExternal,
  nodeTypes.isGeneratorObject,
  nodeTypes.isKeyObject,
  nodeTypes.isMap,
  nodeTypes.isMapIterator,
  nodeTypes.isModuleNamespaceObject,
  nodeTypes.isNativeError,
  nodeTypes.isPromise,
  nodeTypes.isRegExp,
  nodeTypes.isSet,
  nodeTypes.isSetIterator,
  nodeTypes.isWeakMap,
  nodeTypes.isWeakSet
] as const);

function fail(
  code: CanonicalImmutableEnvelopeErrorCode,
  phase: ErrorPhase,
  reason: string,
  path: string,
  extra: {
    readonly axis?: BudgetAxis;
    readonly actual?: number;
    readonly limit?: number;
    readonly cause?: unknown;
    readonly causeProvided?: boolean;
  } = {}
): never {
  const details = {
    phase,
    reason,
    path,
    ...(extra.axis === undefined ? {} : { axis: extra.axis }),
    ...(extra.actual === undefined ? {} : { actual: extra.actual }),
    ...(extra.limit === undefined ? {} : { limit: extra.limit })
  };
  throw new CanonicalImmutableEnvelopeError(
    code,
    `${phase}: ${reason}`,
    details,
    extra.causeProvided === true ? { cause: extra.cause } : undefined
  );
}

function encodedBytes(value: string): number {
  const encoded = reflectApply(textEncode, textEncoder, [value]);
  if (typedArrayByteLength === undefined) {
    contractFailure("utf8-byte-length-unavailable");
  }
  return reflectApply(typedArrayByteLength, encoded, []);
}

function boundedPath(parent: string, segment: string): string {
  if (parent === "<path-too-long>") return parent;
  const tildeEscaped = reflectApply(stringReplaceAll, segment, ["~", "~0"]);
  const escaped = reflectApply(stringReplaceAll, tildeEscaped, ["/", "~1"]);
  const next = `${parent}/${escaped}`;
  return encodedBytes(next) > CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxErrorPathBytes
    ? "<path-too-long>"
    : next;
}

function contractFailure(reason: string): never {
  fail("INVALID_CONTRACT", "contract", reason, "");
}

function validateContract(
  profile: CanonicalImmutableEnvelopeProfile,
  spec: CanonicalImmutableEnvelopeSpec
): void {
  if (profile !== "external-mutable" && profile !== "attunegraph-frozen") {
    contractFailure("invalid-profile");
  }
  if (spec === null || typeof spec !== "object") {
    contractFailure("invalid-spec");
  }
  const { hashDomain, idField, idPrefix } = spec;
  if (
    typeof hashDomain !== "string"
    || hashDomain.length === 0
    || hashDomain.length > CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxHashDomainBytes
    || !reflectApply(regExpTest, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u, [hashDomain])
    || encodedBytes(hashDomain) !== hashDomain.length
  ) {
    contractFailure("invalid-hash-domain");
  }
  if (
    typeof idField !== "string"
    || idField.length > CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxIdFieldBytes
    || !reflectApply(regExpTest, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u, [idField])
    || encodedBytes(idField) !== idField.length
  ) {
    contractFailure("invalid-id-field");
  }
  if (
    typeof idPrefix !== "string"
    || idPrefix.length === 0
    || idPrefix.length > CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxIdPrefixBytes
    || !reflectApply(regExpTest, /^[\x20-\x7E]+$/u, [idPrefix])
    || encodedBytes(idPrefix) !== idPrefix.length
  ) {
    contractFailure("invalid-id-prefix");
  }
}

function validateByteLimits(
  value: CanonicalImmutableEnvelopeByteLimits
): CanonicalImmutableEnvelopeByteLimits {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
    || arrayIsArray(value)
  ) {
    contractFailure("invalid-byte-limits");
  }
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) {
    contractFailure("invalid-byte-limits");
  }
  const keys = reflectOwnKeys(value);
  const firstKey = keys[0];
  const secondKey = keys[1];
  if (
    keys.length !== 2
    || !(
      (
        firstKey === "maxCanonicalBodyBytes"
        && secondKey === "maxEnvelopeBytes"
      )
      || (
        firstKey === "maxEnvelopeBytes"
        && secondKey === "maxCanonicalBodyBytes"
      )
    )
  ) {
    contractFailure("invalid-byte-limits");
  }
  const bodyDescriptor = reflectGetOwnPropertyDescriptor(
    value,
    "maxCanonicalBodyBytes"
  );
  const envelopeDescriptor = reflectGetOwnPropertyDescriptor(
    value,
    "maxEnvelopeBytes"
  );
  if (
    bodyDescriptor === undefined
    || envelopeDescriptor === undefined
    || !("value" in bodyDescriptor)
    || !("value" in envelopeDescriptor)
  ) {
    contractFailure("invalid-byte-limits");
  }
  const maxCanonicalBodyBytes = bodyDescriptor.value;
  const maxEnvelopeBytes = envelopeDescriptor.value;
  if (
    typeof maxCanonicalBodyBytes !== "number"
    || typeof maxEnvelopeBytes !== "number"
    || !numberIsSafeInteger(maxCanonicalBodyBytes)
    || !numberIsSafeInteger(maxEnvelopeBytes)
    || maxCanonicalBodyBytes < 1
    || maxEnvelopeBytes < 1
    || maxCanonicalBodyBytes > maxEnvelopeBytes
    || maxEnvelopeBytes > MAX_INTERNAL_CANONICAL_BYTE_LIMIT
  ) {
    contractFailure("invalid-byte-limits");
  }
  return objectFreeze({
    maxCanonicalBodyBytes,
    maxEnvelopeBytes
  });
}

function reflection<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    fail("INVALID_INPUT", "inspect", "reflection-failed", path, {
      cause,
      causeProvided: true
    });
  }
}

function chargeDescriptors(state: InspectionState, amount: number, path: string): void {
  const actual = state.descriptors + amount;
  const limit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDescriptors;
  if (actual > limit) {
    fail("BUDGET_EXCEEDED", "inspect", "budget-exceeded", path, {
      axis: "descriptors",
      actual,
      limit
    });
  }
  state.descriptors = actual;
}

function validateAndChargeString(
  value: string,
  state: InspectionState,
  path: string
): void {
  const codeUnitLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringCodeUnits;
  if (value.length > codeUnitLimit) {
    fail("BUDGET_EXCEEDED", "inspect", "budget-exceeded", path, {
      axis: "string-code-units",
      actual: value.length,
      limit: codeUnitLimit
    });
  }

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = reflectApply(stringCharCodeAt, value, [index]);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = reflectApply(stringCharCodeAt, value, [index + 1]);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        fail("INVALID_INPUT", "inspect", "unpaired-surrogate", path);
      }
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("INVALID_INPUT", "inspect", "unpaired-surrogate", path);
    } else {
      bytes += 3;
    }
  }

  const stringByteLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringBytes;
  if (bytes > stringByteLimit) {
    fail("BUDGET_EXCEEDED", "inspect", "budget-exceeded", path, {
      axis: "string-bytes",
      actual: bytes,
      limit: stringByteLimit
    });
  }
  const aggregate = state.aggregateStringBytes + bytes;
  const aggregateLimit = CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxAggregateStringBytes;
  if (aggregate > aggregateLimit) {
    fail("BUDGET_EXCEEDED", "inspect", "budget-exceeded", path, {
      axis: "aggregate-string-bytes",
      actual: aggregate,
      limit: aggregateLimit
    });
  }
  state.aggregateStringBytes = aggregate;
}

function validateNumber(value: number, path: string): number {
  if (
    !numberIsFinite(value)
    || objectIs(value, -0)
    || (numberIsInteger(value) && !numberIsSafeInteger(value))
  ) {
    fail("INVALID_INPUT", "inspect", "unsupported-number", path);
  }
  return value;
}

function rejectProxyAndBrands(value: object, path: string): void {
  if (typeof isProxy !== "function") {
    fail("INVALID_INPUT", "inspect", "proxy-detection-unavailable", path);
  }
  const proxy = reflection(path, () => isProxy(value));
  if (proxy) fail("INVALID_INPUT", "inspect", "proxy", path);
  for (let index = 0; index < brandPredicates.length; index += 1) {
    const predicate = brandPredicates[index];
    if (predicate === undefined) {
      fail("INVALID_INPUT", "inspect", "brand-detection-unavailable", path);
    }
    if (reflection(path, () => predicate(value))) {
      fail("INVALID_INPUT", "inspect", "unsupported-brand", path);
    }
  }
}

function assertContainerProfile(
  value: object,
  profile: CanonicalImmutableEnvelopeProfile,
  path: string
): void {
  const extensible = reflection(path, () => reflectIsExtensible(value));
  const expected = profile === "external-mutable";
  if (extensible !== expected) {
    fail("PROFILE_MISMATCH", "inspect", "container-extensibility", path);
  }
}

function assertDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  profile: CanonicalImmutableEnvelopeProfile,
  path: string,
  arrayLength = false
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined || !("value" in descriptor)) {
    fail("INVALID_INPUT", "inspect", "accessor-or-missing-descriptor", path);
  }
  const writable = profile === "external-mutable";
  if (
    descriptor.writable !== writable
    || descriptor.enumerable !== !arrayLength
    || descriptor.configurable !== (arrayLength ? false : writable)
  ) {
    fail("PROFILE_MISMATCH", "inspect", "descriptor-flags", path);
  }
}

function isArrayIndex(key: string): boolean {
  if (key === "") return false;
  const number = numberConstructor(key);
  return (
    numberIsInteger(number)
    && number >= 0
    && number < 4294967295
    && stringConstructor(number) === key
  );
}

function defineDetachedField(
  target: Record<string, DetachedValue> | DetachedValue[],
  key: string,
  value: DetachedValue
): void {
  objectDefineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function inspectValue(
  value: unknown,
  depth: number,
  path: string,
  state: InspectionState
): DetachedValue {
  if (depth > CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDepth) {
    fail("BUDGET_EXCEEDED", "inspect", "budget-exceeded", path, {
      axis: "depth",
      actual: depth,
      limit: CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxDepth
    });
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    validateAndChargeString(value, state, path);
    return value;
  }
  if (typeof value === "number") return validateNumber(value, path);
  if (typeof value !== "object") {
    fail("INVALID_INPUT", "inspect", "unsupported-value", path);
  }

  if (reflectApply(weakSetHas, state.active, [value])) {
    fail("INVALID_INPUT", "inspect", "cycle", path);
  }
  if (reflectApply(weakSetHas, state.seen, [value])) {
    fail("INVALID_INPUT", "inspect", "alias", path);
  }
  reflectApply(weakSetAdd, state.active, [value]);
  reflectApply(weakSetAdd, state.seen, [value]);
  rejectProxyAndBrands(value, path);
  const array = arrayIsArray(value);
  if (depth === 0 && array) fail("INVALID_INPUT", "inspect", "root-not-record", path);
  const prototype = reflection(path, () => reflectGetPrototypeOf(value));
  if (
    array
      ? prototype !== arrayPrototype
      : state.profile === "external-mutable"
        ? prototype !== objectPrototype && prototype !== null
        : state.allowFrozenPlainRecordPrototype
          ? prototype !== objectPrototype && prototype !== null
          : prototype !== null
  ) {
    fail("INVALID_INPUT", "inspect", "unsupported-prototype", path);
  }
  assertContainerProfile(value, state.profile, path);
  chargeDescriptors(state, 1, path);
  const keys = reflection(path, () => reflectOwnKeys(value));

  let output: DetachedValue;
  if (array) {
    output = inspectArray(value, keys, depth, path, state);
  } else {
    output = inspectRecord(value, keys, depth, path, state);
  }
  reflectApply(weakSetDelete, state.active, [value]);
  return output;
}

function inspectArray(
  source: object,
  keys: readonly PropertyKey[],
  depth: number,
  path: string,
  state: InspectionState
): DetachedValue[] {
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] === "symbol") {
      fail("INVALID_INPUT", "inspect", "symbol-key", path);
    }
  }
  const stringKeys = keys as readonly string[];
  let hasLength = false;
  for (let index = 0; index < stringKeys.length; index += 1) {
    const key = stringKeys[index];
    if (key === "length") {
      hasLength = true;
    } else if (key === undefined || !isArrayIndex(key)) {
      fail("INVALID_INPUT", "inspect", "array-extra-key", path);
    }
  }
  if (!hasLength) {
    fail("INVALID_INPUT", "inspect", "array-extra-key", path);
  }
  chargeDescriptors(state, stringKeys.length - 1, path);
  const descriptors = new mapConstructor<string, PropertyDescriptor>();
  for (let index = 0; index < stringKeys.length; index += 1) {
    const key = stringKeys[index];
    if (key === undefined) {
      fail("INVALID_INPUT", "inspect", "array-extra-key", path);
    }
    const keyPath = boundedPath(path, key);
    const descriptor = reflection(keyPath, () => reflectGetOwnPropertyDescriptor(source, key));
    assertDataDescriptor(descriptor, state.profile, keyPath, key === "length");
    reflectApply(mapSet, descriptors, [key, descriptor]);
  }
  const length = reflectApply(mapGet, descriptors, ["length"])?.value;
  if (
    typeof length !== "number"
    || !numberIsInteger(length)
    || length < 0
    || length > 4294967295
    || stringKeys.length !== length + 1
  ) {
    fail("INVALID_INPUT", "inspect", "sparse-array", path);
  }
  for (let index = 0; index < length; index += 1) {
    const key = stringConstructor(index);
    if (!reflectApply(mapHas, descriptors, [key])) {
      fail("INVALID_INPUT", "inspect", "sparse-array", boundedPath(path, key));
    }
  }
  const output = new arrayConstructor<DetachedValue>(length);
  for (let index = 0; index < length; index += 1) {
    const key = stringConstructor(index);
    defineDetachedField(
      output,
      key,
      inspectValue(
        reflectApply(mapGet, descriptors, [key])?.value,
        depth + 1,
        boundedPath(path, key),
        state
      )
    );
  }
  return output;
}

function wellFormedContentId(value: string, spec: CanonicalImmutableEnvelopeSpec): boolean {
  return (
    reflectApply(stringStartsWith, value, [spec.idPrefix])
    && value.length === spec.idPrefix.length + 64
    && reflectApply(
      regExpTest,
      /^[0-9a-f]{64}$/u,
      [reflectApply(stringSlice, value, [spec.idPrefix.length])]
    )
  );
}

function inspectRecord(
  source: object,
  keys: readonly PropertyKey[],
  depth: number,
  path: string,
  state: InspectionState
): Record<string, DetachedValue> {
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] === "symbol") {
      fail("INVALID_INPUT", "inspect", "symbol-key", path);
    }
  }
  const stringKeys = keys as readonly string[];
  const root = depth === 0;
  let hasId = false;
  if (root) {
    for (let index = 0; index < stringKeys.length; index += 1) {
      if (stringKeys[index] === state.spec.idField) {
        hasId = true;
        break;
      }
    }
  }
  if (
    root
    && state.profile === "attunegraph-frozen"
    && !hasId
    && !state.allowMissingFrozenRootId
  ) {
    fail("INVALID_INPUT", "inspect", "missing-id", path);
  }
  if (root && state.allowMissingFrozenRootId && hasId) {
    fail("INVALID_INPUT", "inspect", "expected-unsigned-root", path);
  }
  chargeDescriptors(state, stringKeys.length + (root && !hasId ? 1 : 0), path);
  if (root && !hasId) {
    validateAndChargeString(state.spec.idField, state, boundedPath(path, state.spec.idField));
    validateAndChargeString(
      `${state.spec.idPrefix}${reflectApply(stringRepeat, "0", [64])}`,
      state,
      boundedPath(path, state.spec.idField)
    );
  }

  const output = objectCreate(null) as Record<string, DetachedValue>;
  for (let index = 0; index < stringKeys.length; index += 1) {
    const key = stringKeys[index];
    if (key === undefined) {
      fail("INVALID_INPUT", "inspect", "invalid-key", path);
    }
    const keyPath = boundedPath(path, key);
    validateAndChargeString(key, state, keyPath);
    const descriptor = reflection(keyPath, () => reflectGetOwnPropertyDescriptor(source, key));
    assertDataDescriptor(descriptor, state.profile, keyPath);
    const child = inspectValue(descriptor.value, depth + 1, keyPath, state);
    if (root && key === state.spec.idField) {
      if (typeof child !== "string" || !wellFormedContentId(child, state.spec)) {
        fail("INVALID_INPUT", "inspect", "malformed-id", keyPath);
      }
      state.suppliedId = child;
    } else {
      defineDetachedField(output, key, child);
    }
  }
  return output;
}

function inspectEnvelope(
  input: unknown,
  profile: CanonicalImmutableEnvelopeProfile,
  spec: CanonicalImmutableEnvelopeSpec,
  allowMissingFrozenRootId = false,
  allowFrozenPlainRecordPrototype = false
): { readonly body: Record<string, DetachedValue>; readonly suppliedId?: string } {
  const state: InspectionState = {
    profile,
    spec,
    allowMissingFrozenRootId,
    allowFrozenPlainRecordPrototype,
    active: new weakSetConstructor(),
    seen: new weakSetConstructor(),
    descriptors: 0,
    aggregateStringBytes: 0
  };
  const body = inspectValue(input, 0, "", state);
  if (body === null || typeof body !== "object" || arrayIsArray(body)) {
    fail("INVALID_INPUT", "inspect", "root-not-record", "");
  }
  return state.suppliedId === undefined
    ? { body }
    : { body, suppliedId: state.suppliedId };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecordKeys(
  value: object,
  omitRootKey?: string
): string[] {
  const reflected = reflectOwnKeys(value);
  const keys = new arrayConstructor<string>();
  for (let index = 0; index < reflected.length; index += 1) {
    const key = reflected[index];
    if (typeof key !== "string") {
      fail("POSTCONDITION_FAILED", "postverify", "detached-symbol", "");
    }
    if (key !== omitRootKey) keys[keys.length] = key;
  }
  for (let index = 1; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      fail("POSTCONDITION_FAILED", "postverify", "detached-key", "");
    }
    let target = index;
    while (target > 0) {
      const previous = keys[target - 1];
      if (previous === undefined || compareCodeUnits(previous, key) <= 0) break;
      keys[target] = previous;
      target -= 1;
    }
    keys[target] = key;
  }
  return keys;
}

function encodeCanonical(
  value: DetachedValue,
  limit: number,
  axis: "canonical-body-bytes" | "full-envelope-bytes",
  omitRootKey?: string
): { readonly json: string; readonly bytes: number } {
  let json = "";
  let bytes = 0;
  const append = (fragment: string): void => {
    const next = bytes + encodedBytes(fragment);
    if (next > limit) {
      fail("BUDGET_EXCEEDED", "encode", "budget-exceeded", "", {
        axis,
        actual: limit + 1,
        limit
      });
    }
    bytes = next;
    json += fragment;
  };
  const visit = (current: DetachedValue, root: boolean): void => {
    if (current === null || typeof current === "boolean" || typeof current === "number" || typeof current === "string") {
      const token = jsonStringify(current);
      if (token === undefined) fail("POSTCONDITION_FAILED", "postverify", "primitive-encoding", "");
      append(token);
      return;
    }
    if (arrayIsArray(current)) {
      append("[");
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) append(",");
        visit(current[index] as DetachedValue, false);
      }
      append("]");
      return;
    }
    const keys = sortedRecordKeys(current, root ? omitRootKey : undefined);
    append("{");
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) append(",");
      const key = keys[index] as string;
      const descriptor = reflectGetOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        fail("POSTCONDITION_FAILED", "postverify", "detached-descriptor", boundedPath("", key));
      }
      const token = jsonStringify(key);
      if (token === undefined) fail("POSTCONDITION_FAILED", "postverify", "key-encoding", boundedPath("", key));
      append(token);
      append(":");
      visit(descriptor.value as DetachedValue, false);
    }
    append("}");
  };
  visit(value, true);
  return { json, bytes };
}

function digest(hashDomain: string, unsignedCanonicalJson: string): string {
  const hash = createHash("sha256");
  reflectApply(hashUpdate, hash, [hashDomain, "utf8"]);
  reflectApply(hashUpdate, hash, ["\0", "utf8"]);
  reflectApply(hashUpdate, hash, [unsignedCanonicalJson, "utf8"]);
  return reflectApply(hashDigest, hash, ["hex"]) as string;
}

function freezeBottomUp(value: DetachedValue): void {
  if (value === null || typeof value !== "object") return;
  const array = arrayIsArray(value);
  const keys = reflectOwnKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      fail("POSTCONDITION_FAILED", "freeze", "freeze-key", "");
    }
    if (array && key === "length") continue;
    const descriptor = reflectGetOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      freezeBottomUp(descriptor.value as DetachedValue);
    }
  }
  objectFreeze(value);
}

function assertFrozenOutput(value: DetachedValue, path = ""): void {
  if (value === null || typeof value !== "object") return;
  const array = arrayIsArray(value);
  if (reflectGetPrototypeOf(value) !== (array ? arrayPrototype : null)) {
    fail("POSTCONDITION_FAILED", "postverify", "output-prototype", path);
  }
  if (reflectIsExtensible(value) || !objectIsFrozen(value)) {
    fail("POSTCONDITION_FAILED", "postverify", "output-not-frozen", path);
  }
  const keys = reflectOwnKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      fail("POSTCONDITION_FAILED", "postverify", "output-key", path);
    }
    if (typeof key === "symbol") {
      fail("POSTCONDITION_FAILED", "postverify", "output-symbol", path);
    }
    const keyPath = boundedPath(path, key);
    const descriptor = reflectGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("POSTCONDITION_FAILED", "postverify", "output-accessor", keyPath);
    }
    const length = array && key === "length";
    if (
      descriptor.writable !== false
      || descriptor.enumerable !== !length
      || descriptor.configurable !== false
    ) {
      fail("POSTCONDITION_FAILED", "postverify", "output-descriptor", keyPath);
    }
    if (!length) assertFrozenOutput(descriptor.value as DetachedValue, keyPath);
  }
}

export function canonicalizeImmutableEnvelope(
  input: unknown,
  profile: CanonicalImmutableEnvelopeProfile,
  spec: CanonicalImmutableEnvelopeSpec
): CanonicalImmutableEnvelopeResult {
  return canonicalizeImmutableEnvelopeForInternalUse(
    input,
    profile,
    spec,
    DEFAULT_CANONICAL_BYTE_LIMITS
  );
}

export function canonicalizeImmutableEnvelopeForInternalUse(
  input: unknown,
  profile: CanonicalImmutableEnvelopeProfile,
  spec: CanonicalImmutableEnvelopeSpec,
  limits: CanonicalImmutableEnvelopeByteLimits
): CanonicalImmutableEnvelopeResult {
  return canonicalizeImmutableEnvelopeWithInternalOptions(
    input,
    profile,
    spec,
    limits,
    false,
    false
  );
}

export function mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
  input: unknown,
  spec: CanonicalImmutableEnvelopeSpec,
  limits: CanonicalImmutableEnvelopeByteLimits = DEFAULT_CANONICAL_BYTE_LIMITS
): CanonicalImmutableEnvelopeResult {
  return canonicalizeImmutableEnvelopeWithInternalOptions(
    input,
    "attunegraph-frozen",
    spec,
    limits,
    true,
    true
  );
}

function canonicalizeImmutableEnvelopeWithInternalOptions(
  input: unknown,
  profile: CanonicalImmutableEnvelopeProfile,
  spec: CanonicalImmutableEnvelopeSpec,
  limits: CanonicalImmutableEnvelopeByteLimits,
  allowMissingFrozenRootId: boolean,
  allowFrozenPlainRecordPrototype: boolean
): CanonicalImmutableEnvelopeResult {
  validateContract(profile, spec);
  const byteLimits = validateByteLimits(limits);
  const inspected = inspectEnvelope(
    input,
    profile,
    spec,
    allowMissingFrozenRootId,
    allowFrozenPlainRecordPrototype
  );
  const unsigned = encodeCanonical(
    inspected.body,
    byteLimits.maxCanonicalBodyBytes,
    "canonical-body-bytes"
  );
  const contentId = `${spec.idPrefix}${digest(spec.hashDomain, unsigned.json)}`;
  defineDetachedField(inspected.body, spec.idField, contentId);
  const full = encodeCanonical(
    inspected.body,
    byteLimits.maxEnvelopeBytes,
    "full-envelope-bytes"
  );
  if (inspected.suppliedId !== undefined && inspected.suppliedId !== contentId) {
    fail("INTEGRITY_MISMATCH", "integrity", "content-id-mismatch", boundedPath("", spec.idField));
  }

  try {
    freezeBottomUp(inspected.body);
  } catch (cause) {
    fail("POSTCONDITION_FAILED", "freeze", "freeze-failed", "", {
      cause,
      causeProvided: true
    });
  }
  try {
    assertFrozenOutput(inspected.body);
    const unsignedAgain = encodeCanonical(
      inspected.body,
      byteLimits.maxCanonicalBodyBytes,
      "canonical-body-bytes",
      spec.idField
    );
    const fullAgain = encodeCanonical(
      inspected.body,
      byteLimits.maxEnvelopeBytes,
      "full-envelope-bytes"
    );
    const digestAgain = digest(spec.hashDomain, unsignedAgain.json);
    if (
      unsignedAgain.json !== unsigned.json
      || unsignedAgain.bytes !== unsigned.bytes
      || fullAgain.json !== full.json
      || fullAgain.bytes !== full.bytes
      || `${spec.idPrefix}${digestAgain}` !== contentId
    ) {
      fail("POSTCONDITION_FAILED", "postverify", "reverification-mismatch", "");
    }
  } catch (cause) {
    if (
      cause !== null
      && typeof cause === "object"
      && reflectGetPrototypeOf(cause) === canonicalImmutableEnvelopeErrorPrototype
    ) {
      throw cause;
    }
    fail("POSTCONDITION_FAILED", "postverify", "postverification-failed", "", {
      cause,
      causeProvided: true
    });
  }

  return objectFreeze({
    envelope: inspected.body,
    canonicalJson: full.json,
    canonicalByteLength: full.bytes,
    contentId
  });
}
