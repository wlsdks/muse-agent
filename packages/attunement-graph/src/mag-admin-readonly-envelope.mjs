import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

export const MAX_ADMIN_ENVELOPE_BYTES = 65_536;

/** @typedef {null | boolean | number | string | readonly JsonData[] | { readonly [key: string]: JsonData }} JsonData */

/** @returns {never} */
function invalidAdminEnvelope() {
  throw new TypeError("Invalid Admin envelope");
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} ancestors
 * @returns {JsonData}
 */
function detachJsonData(value, ancestors) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidAdminEnvelope();
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    return invalidAdminEnvelope();
  }
  if (ancestors.has(value)) return invalidAdminEnvelope();

  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalidAdminEnvelope();
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined
        || !Object.hasOwn(lengthDescriptor, "value")
        || typeof lengthDescriptor.value !== "number"
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
      ) {
        return invalidAdminEnvelope();
      }
      const dataKeys = ownKeys.filter((key) => key !== "length");
      if (dataKeys.length !== lengthDescriptor.value) {
        return invalidAdminEnvelope();
      }
      const clone = [];
      for (let index = 0; index < dataKeys.length; index += 1) {
        const key = dataKeys[index];
        if (key !== String(index)) invalidAdminEnvelope();
        const descriptor = descriptors[key];
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value")
        ) {
          return invalidAdminEnvelope();
        }
        clone.push(detachJsonData(descriptor.value, ancestors));
      }
      return Object.freeze(clone);
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return invalidAdminEnvelope();
    }
    /** @type {Record<string, JsonData>} */
    const clone = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== "string") invalidAdminEnvelope();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) {
        return invalidAdminEnvelope();
      }
      clone[key] = detachJsonData(descriptor.value, ancestors);
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * @param {unknown} value
 * @returns {Readonly<{value: JsonData, byteLength: number}>}
 */
export function admitAdminEnvelope(value) {
  const detached = detachJsonData(value, new WeakSet());
  const serialized = JSON.stringify(detached);
  if (serialized === undefined) invalidAdminEnvelope();
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_ADMIN_ENVELOPE_BYTES) invalidAdminEnvelope();
  return Object.freeze({ value: detached, byteLength });
}
