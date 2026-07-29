import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isProxy } from "node:util/types";

import {
  bindProviderOwnedHeadRevalidation
} from "./local-attunement-snapshot-head-revalidation.js";
import { parseAttunementState } from "./state-validation.js";

import type { AttunementState } from "./types.js";
import type {
  LocalAttunementSnapshotHeadRevalidation
} from "./local-attunement-snapshot-head-revalidation.js";

export const LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID =
  "muse.local-attunement-store" as const;
export const LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION =
  "muse.local-attunement-snapshot-provider.v1" as const;
export const LOCAL_ATTUNEMENT_SNAPSHOT_RECEIPT_VERSION =
  "muse.local-attunement-snapshot-receipt.v1" as const;
export const LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES = 4_194_304;
export const LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES = 4_194_304;
export const LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RECEIPT_BYTES = 8_192;

const RECEIPT_DOMAIN =
  "muse.attunement.local-attunement-snapshot-receipt.v1\0";
const RECEIPT_ID_PREFIX = "muse-local-attunement-snapshot:sha256:";
const RECEIPT_ID = /^muse-local-attunement-snapshot:sha256:[0-9a-f]{64}$/u;
const STATE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const PROVIDER_ERROR_MESSAGE = "local-attunement-snapshot-provider-failed";
const RECEIPT_ERROR_MESSAGE = "local-attunement-snapshot-receipt-failed";
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_RECEIPT_DESCRIPTORS = 64;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;

export interface LocalAttunementSnapshotProviderOptions {
  readonly attunementFile: string;
  readonly sourceId: string;
  readonly clock?: () => Date;
}

export interface LocalAttunementSnapshotScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export type LocalAttunementSnapshotAbstentionReason =
  | "source-read-failed"
  | "requested-scope-unavailable"
  | "source-capacity-exceeded";

interface ReceiptCommon {
  readonly schemaVersion: 1;
  readonly receiptVersion: typeof LOCAL_ATTUNEMENT_SNAPSHOT_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly authority: "receipt-integrity-only";
  readonly providerId: typeof LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID;
  readonly providerVersion: typeof LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION;
  readonly scope: LocalAttunementSnapshotScope;
  readonly captureCompletedAt: string;
  readonly freshness: Readonly<{
    readonly status: "unassessed";
    readonly reason: "single-read-no-head-revalidation";
  }>;
}

export interface LocalAttunementSnapshotReceiptV1 extends ReceiptCommon {
  readonly status: "available";
  readonly stateDigest: string;
  readonly normalizedStateBytes: number;
  readonly coverage: Readonly<{
    readonly status: "partial";
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly reasons: readonly [
      "single-local-store",
      "requested-thread-exists",
      "point-in-time-read"
    ];
  }>;
}

export interface LocalAttunementSnapshotAbstentionReceiptV1
  extends ReceiptCommon {
  readonly status: "abstained";
  readonly reason: LocalAttunementSnapshotAbstentionReason;
  readonly coverage: Readonly<{
    readonly status: "abstained";
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly reasons: readonly ["no-available-provider-snapshot"];
  }>;
}

export type LocalAttunementSnapshotReceipt =
  | LocalAttunementSnapshotReceiptV1
  | LocalAttunementSnapshotAbstentionReceiptV1;

export type LocalAttunementSnapshotCapture =
  | Readonly<{
      readonly status: "available";
      readonly provenance: "provider-observed-configured-local-snapshot";
      readonly normalizedStateJson: string;
      readonly receipt: LocalAttunementSnapshotReceiptV1;
    }>
  | Readonly<{
      readonly status: "abstained";
      readonly provenance: "provider-attempted-configured-local-snapshot";
      readonly receipt: LocalAttunementSnapshotAbstentionReceiptV1;
    }>;

declare const VERIFIED_MINTED_CAPTURE: unique symbol;
export type VerifiedMintedLocalAttunementSnapshotCapture =
  LocalAttunementSnapshotCapture & {
    readonly [VERIFIED_MINTED_CAPTURE]: true;
  };

export interface LocalAttunementSnapshotProvider {
  readonly providerId: typeof LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID;
  readonly providerVersion: typeof LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION;
  readonly sourceId: string;
  capture(scope: unknown): Promise<LocalAttunementSnapshotCapture>;
  captureHeadRevalidation(
    scope: unknown,
    options: unknown
  ): Promise<LocalAttunementSnapshotHeadRevalidation>;
}

export type LocalAttunementSnapshotProviderErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_SCOPE"
  | "INTERNAL_POSTCONDITION_FAILED";

export type LocalAttunementSnapshotProviderErrorReason =
  | "invalid-file"
  | "invalid-source-id"
  | "invalid-configuration-envelope"
  | "invalid-scope-envelope"
  | "invalid-thread-id"
  | "source-id-mismatch"
  | "invalid-clock"
  | "bounded-read-postcondition-failed"
  | "normalized-state-postcondition-failed"
  | "receipt-postcondition-failed";

export class LocalAttunementSnapshotProviderError extends Error {
  readonly code: LocalAttunementSnapshotProviderErrorCode;
  readonly details: Readonly<{
    readonly reason: LocalAttunementSnapshotProviderErrorReason;
    readonly path: string;
  }>;

  constructor(
    code: LocalAttunementSnapshotProviderErrorCode,
    reason: LocalAttunementSnapshotProviderErrorReason,
    path: string
  ) {
    super(PROVIDER_ERROR_MESSAGE);
    this.name = "LocalAttunementSnapshotProviderError";
    this.code = code;
    this.details = Object.freeze({ path: boundedPath(path), reason });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value: this[key],
        writable: false
      });
    }
    Object.freeze(this);
  }
}

export type LocalAttunementSnapshotReceiptErrorCode =
  | "INVALID_RECEIPT"
  | "RECEIPT_CAPACITY_EXCEEDED"
  | "INTEGRITY_MISMATCH"
  | "UNTRUSTED_CAPTURE";

export type LocalAttunementSnapshotReceiptErrorReason =
  | "invalid-envelope"
  | "invalid-field-set"
  | "invalid-schema"
  | "invalid-version"
  | "invalid-status"
  | "invalid-authority"
  | "invalid-provider"
  | "invalid-scope"
  | "invalid-instant"
  | "invalid-freshness"
  | "invalid-digest"
  | "invalid-byte-count"
  | "invalid-coverage"
  | "invalid-abstention"
  | "receipt-capacity-exceeded"
  | "receipt-integrity-mismatch"
  | "not-minted"
  | "invalid-capture-descriptors"
  | "state-capacity-exceeded"
  | "state-digest-mismatch";

export class LocalAttunementSnapshotReceiptError extends Error {
  readonly code: LocalAttunementSnapshotReceiptErrorCode;
  readonly details: Readonly<{
    readonly reason: LocalAttunementSnapshotReceiptErrorReason;
    readonly path: string;
  }>;

  constructor(
    code: LocalAttunementSnapshotReceiptErrorCode,
    reason: LocalAttunementSnapshotReceiptErrorReason,
    path: string
  ) {
    super(RECEIPT_ERROR_MESSAGE);
    this.name = "LocalAttunementSnapshotReceiptError";
    this.code = code;
    this.details = Object.freeze({ path: boundedPath(path), reason });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value: this[key],
        writable: false
      });
    }
    Object.freeze(this);
  }
}

type BoundedReadDisposition =
  | Readonly<{ readonly status: "available"; readonly state: AttunementState }>
  | Readonly<{ readonly status: "missing" | "capacity" | "invalid" | "io-failed" }>;

interface ProviderDependencies {
  readonly readState: (file: string) => Promise<BoundedReadDisposition>;
  readonly clock: () => Date;
}

interface ReceiptParseContext {
  descriptors: number;
  readonly seen: Set<object>;
}

const mintedCaptures = new WeakSet<object>();
const captureOwners = new WeakMap<object, object>();
const providerOwners = new WeakMap<object, object>();

function boundedPath(path: string): string {
  return Buffer.byteLength(path, "utf8") <= 512 ? path : "<path-too-long>";
}

function child(path: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return boundedPath(`${path}/${escaped}`);
}

function providerFail(
  code: LocalAttunementSnapshotProviderErrorCode,
  reason: LocalAttunementSnapshotProviderErrorReason,
  path: string
): never {
  throw new LocalAttunementSnapshotProviderError(code, reason, path);
}

function receiptFail(
  code: LocalAttunementSnapshotReceiptErrorCode,
  reason: LocalAttunementSnapshotReceiptErrorReason,
  path: string
): never {
  throw new LocalAttunementSnapshotReceiptError(code, reason, path);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && (value as { readonly code?: unknown }).code === code;
}

function plainDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  reason: LocalAttunementSnapshotProviderErrorReason,
  path: string
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || isProxy(value)
  ) {
    providerFail(
      path === "/scope" ? "INVALID_SCOPE" : "INVALID_CONFIGURATION",
      path === "/scope" ? reason : "invalid-configuration-envelope",
      path
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    providerFail(
      path === "/scope" ? "INVALID_SCOPE" : "INVALID_CONFIGURATION",
      path === "/scope" ? reason : "invalid-configuration-envelope",
      path
    );
  }
  const keys = Reflect.ownKeys(value);
  const permitted = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => typeof key === "string" && !permitted.has(key))
  ) {
    providerFail(
      path === "/scope" ? "INVALID_SCOPE" : "INVALID_CONFIGURATION",
      path === "/scope" ? reason : "invalid-configuration-envelope",
      path
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) =>
    typeof key !== "string"
    || descriptors[key] === undefined
    || !("value" in descriptors[key])
  )) {
    providerFail(
      path === "/scope" ? "INVALID_SCOPE" : "INVALID_CONFIGURATION",
      path === "/scope" ? reason : "invalid-configuration-envelope",
      path
    );
  }
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [
        key as string,
        (descriptors[key as string] as PropertyDescriptor & { value: unknown }).value
      ])
    )
  );
}

function parseOptions(
  input: LocalAttunementSnapshotProviderOptions
): Readonly<{
  readonly attunementFile: string;
  readonly sourceId: string;
  readonly clock?: () => Date;
}> {
  const value = plainDataRecord(
    input,
    ["attunementFile", "sourceId"],
    ["clock"],
    "invalid-file",
    "/"
  );
  if (
    typeof value.attunementFile !== "string"
    || value.attunementFile.trim().length === 0
    || value.attunementFile.includes("\0")
    || utf8Bytes(value.attunementFile) > 4_096
  ) {
    providerFail("INVALID_CONFIGURATION", "invalid-file", "/attunementFile");
  }
  if (typeof value.sourceId !== "string" || !SOURCE_ID.test(value.sourceId)) {
    providerFail("INVALID_CONFIGURATION", "invalid-source-id", "/sourceId");
  }
  if (value.clock !== undefined && typeof value.clock !== "function") {
    providerFail("INVALID_CONFIGURATION", "invalid-clock", "/clock");
  }
  return Object.freeze({
    attunementFile: value.attunementFile,
    sourceId: value.sourceId,
    ...(value.clock === undefined
      ? {}
      : { clock: value.clock as () => Date })
  });
}

function parseScope(
  value: unknown,
  expectedSourceId: string
): LocalAttunementSnapshotScope {
  const record = plainDataRecord(
    value,
    ["sourceId", "threadId"],
    [],
    "invalid-scope-envelope",
    "/scope"
  );
  if (record.sourceId !== expectedSourceId) {
    providerFail("INVALID_SCOPE", "source-id-mismatch", "/scope/sourceId");
  }
  if (
    typeof record.threadId !== "string"
    || record.threadId.length === 0
    || record.threadId !== record.threadId.trim()
    || CONTROL_CHARACTERS.test(record.threadId)
    || utf8Bytes(record.threadId) > 512
  ) {
    providerFail("INVALID_SCOPE", "invalid-thread-id", "/scope/threadId");
  }
  return Object.freeze({
    sourceId: expectedSourceId,
    threadId: record.threadId
  });
}

function captureCompletedAt(clock: () => Date): string {
  try {
    const value = clock();
    if (
      !(value instanceof Date)
      || value.getTime !== DATE_GET_TIME
      || value.toISOString !== DATE_TO_ISO_STRING
    ) {
      throw new TypeError("invalid clock value");
    }
    const time = Reflect.apply(DATE_GET_TIME, value, []) as number;
    if (!Number.isFinite(time)) throw new TypeError("invalid clock value");
    const completedAt = Reflect.apply(DATE_TO_ISO_STRING, value, []) as string;
    if (
      typeof completedAt !== "string"
      || utf8Bytes(completedAt) > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(completedAt)
    ) {
      throw new TypeError("invalid clock value");
    }
    return completedAt;
  } catch {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "invalid-clock",
      "/captureCompletedAt"
    );
  }
}

function canonicalStateValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "normalized-state-postcondition-failed",
        "/normalizedStateJson"
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalStateValue);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "normalized-state-postcondition-failed",
        "/normalizedStateJson"
      );
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const childValue = (value as Record<string, unknown>)[key];
          return childValue === undefined
            ? []
            : [[key, canonicalStateValue(childValue)]];
        })
    );
  }
  providerFail(
    "INTERNAL_POSTCONDITION_FAILED",
    "normalized-state-postcondition-failed",
    "/normalizedStateJson"
  );
}

function canonicalStateJson(state: AttunementState): string {
  const output = JSON.stringify(canonicalStateValue(state));
  try {
    const reparsed = parseAttunementState(JSON.parse(output) as unknown);
    const repeated = JSON.stringify(canonicalStateValue(reparsed));
    if (repeated !== output) {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "normalized-state-postcondition-failed",
        "/normalizedStateJson"
      );
    }
  } catch (cause) {
    if (cause instanceof LocalAttunementSnapshotProviderError) throw cause;
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "normalized-state-postcondition-failed",
      "/normalizedStateJson"
    );
  }
  return output;
}

async function readBoundedAttunementState(
  file: string
): Promise<BoundedReadDisposition> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch (cause) {
    return Object.freeze({
      status: isNodeErrorCode(cause, "ENOENT") ? "missing" : "io-failed"
    });
  }

  let disposition: BoundedReadDisposition | undefined;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (total <= LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES) {
        const remaining =
          LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES + 1 - total;
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          null
        );
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
      }
    } catch {
      disposition = Object.freeze({ status: "io-failed" as const });
    }
    if (disposition === undefined) {
      if (total > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES) {
        disposition = Object.freeze({ status: "capacity" as const });
      } else {
        try {
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, total)
          );
          const parsed = JSON.parse(raw) as unknown;
          disposition = Object.freeze({
            state: parseAttunementState(parsed),
            status: "available" as const
          });
        } catch (cause) {
          void cause;
          disposition = Object.freeze({ status: "invalid" as const });
        }
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return disposition ?? Object.freeze({ status: "io-failed" as const });
}

function commonReceiptBody(
  scope: LocalAttunementSnapshotScope,
  completedAt: string
): Readonly<{
  readonly schemaVersion: 1;
  readonly receiptVersion: typeof LOCAL_ATTUNEMENT_SNAPSHOT_RECEIPT_VERSION;
  readonly authority: "receipt-integrity-only";
  readonly providerId: typeof LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID;
  readonly providerVersion: typeof LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION;
  readonly scope: LocalAttunementSnapshotScope;
  readonly captureCompletedAt: string;
  readonly freshness: Readonly<{
    readonly status: "unassessed";
    readonly reason: "single-read-no-head-revalidation";
  }>;
}> {
  return Object.freeze({
    schemaVersion: 1,
    receiptVersion: LOCAL_ATTUNEMENT_SNAPSHOT_RECEIPT_VERSION,
    authority: "receipt-integrity-only",
    providerId: LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID,
    providerVersion: LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION,
    scope,
    captureCompletedAt: completedAt,
    freshness: Object.freeze({
      status: "unassessed",
      reason: "single-read-no-head-revalidation"
    })
  });
}

function receiptId(body: object): string {
  const digest = createHash("sha256")
    .update(RECEIPT_DOMAIN, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return `${RECEIPT_ID_PREFIX}${digest}`;
}

function availableReceipt(
  scope: LocalAttunementSnapshotScope,
  completedAt: string,
  normalizedStateJson: string
): LocalAttunementSnapshotReceiptV1 {
  const body = Object.freeze({
    ...commonReceiptBody(scope, completedAt),
    status: "available" as const,
    stateDigest: sha256(normalizedStateJson),
    normalizedStateBytes: utf8Bytes(normalizedStateJson),
    coverage: Object.freeze({
      status: "partial" as const,
      canAssertAbsenceWithinSnapshot: false as const,
      canAssertCurrentWorldAbsence: false as const,
      reasons: Object.freeze([
        "single-local-store",
        "requested-thread-exists",
        "point-in-time-read"
      ] as const)
    })
  });
  return Object.freeze({ ...body, receiptId: receiptId(body) });
}

function abstentionReceipt(
  scope: LocalAttunementSnapshotScope,
  completedAt: string,
  reason: LocalAttunementSnapshotAbstentionReason
): LocalAttunementSnapshotAbstentionReceiptV1 {
  const body = Object.freeze({
    ...commonReceiptBody(scope, completedAt),
    status: "abstained" as const,
    reason,
    coverage: Object.freeze({
      status: "abstained" as const,
      canAssertAbsenceWithinSnapshot: false as const,
      canAssertCurrentWorldAbsence: false as const,
      reasons: Object.freeze(["no-available-provider-snapshot"] as const)
    })
  });
  return Object.freeze({ ...body, receiptId: receiptId(body) });
}

function claimReceiptNode(
  value: object,
  context: ReceiptParseContext,
  path: string
): void {
  if (context.seen.has(value)) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  context.seen.add(value);
}

function receiptRecord(
  value: unknown,
  required: readonly string[],
  path: string,
  context: ReceiptParseContext
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || isProxy(value)
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  claimReceiptNode(value, context, path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  const keys = Reflect.ownKeys(value);
  context.descriptors += keys.length;
  if (
    context.descriptors > MAX_RECEIPT_DESCRIPTORS
    || keys.length !== required.length
    || keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-field-set", path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) =>
    typeof key !== "string"
    || descriptors[key] === undefined
    || !("value" in descriptors[key])
  )) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  return Object.freeze(
    Object.fromEntries(
      required.map((key) => [
        key,
        (descriptors[key] as PropertyDescriptor & { value: unknown }).value
      ])
    )
  );
}

function receiptArray(
  value: unknown,
  expected: readonly string[],
  path: string,
  context: ReceiptParseContext
): readonly string[] {
  if (!Array.isArray(value) || isProxy(value)) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  claimReceiptNode(value, context, path);
  const keys = Reflect.ownKeys(value);
  const expectedKeys = [
    ...expected.map((_item, index) => index.toString()),
    "length"
  ];
  context.descriptors += keys.length;
  if (
    context.descriptors > MAX_RECEIPT_DESCRIPTORS
    || Object.getPrototypeOf(value) !== Array.prototype
    || keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string")
    || !expectedKeys.every((key) => keys.includes(key))
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.value !== expected.length
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", path);
  }
  const output = expected.map((expectedValue, index) => {
    const descriptor = descriptors[index.toString()];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.value !== expectedValue
    ) {
      receiptFail("INVALID_RECEIPT", "invalid-coverage", child(path, `${index}`));
    }
    return expectedValue;
  });
  return Object.freeze(output);
}

function boundedReadDisposition(
  input: unknown
): BoundedReadDisposition {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || isProxy(input)
  ) {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "bounded-read-postcondition-failed",
      "/source"
    );
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "bounded-read-postcondition-failed",
      "/source"
    );
  }
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const statusDescriptor = descriptors.status;
  if (
    statusDescriptor === undefined
    || !("value" in statusDescriptor)
    || keys.some((key) => typeof key !== "string")
  ) {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "bounded-read-postcondition-failed",
      "/source"
    );
  }
  const status = statusDescriptor.value;
  if (status === "available") {
    const stateDescriptor = descriptors.state;
    if (
      keys.length !== 2
      || !Object.hasOwn(input, "status")
      || !Object.hasOwn(input, "state")
      || stateDescriptor === undefined
      || !("value" in stateDescriptor)
    ) {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "bounded-read-postcondition-failed",
        "/source"
      );
    }
    try {
      return Object.freeze({
        state: parseAttunementState(stateDescriptor.value),
        status: "available" as const
      });
    } catch {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "bounded-read-postcondition-failed",
        "/source"
      );
    }
  }
  if (
    status !== "missing"
    && status !== "capacity"
    && status !== "invalid"
    && status !== "io-failed"
  ) {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "bounded-read-postcondition-failed",
      "/source"
    );
  }
  if (keys.length !== 1 || !Object.hasOwn(input, "status")) {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "bounded-read-postcondition-failed",
      "/source"
    );
  }
  return Object.freeze({ status });
}

function receiptInstant(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || utf8Bytes(value) > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-instant", path);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    receiptFail("INVALID_RECEIPT", "invalid-instant", path);
  }
  return value;
}

function receiptScope(
  value: unknown,
  path: string,
  context: ReceiptParseContext
): LocalAttunementSnapshotScope {
  const record = receiptRecord(
    value,
    ["sourceId", "threadId"],
    path,
    context
  );
  if (typeof record.sourceId !== "string" || !SOURCE_ID.test(record.sourceId)) {
    receiptFail("INVALID_RECEIPT", "invalid-scope", child(path, "sourceId"));
  }
  if (
    typeof record.threadId !== "string"
    || record.threadId.length === 0
    || record.threadId !== record.threadId.trim()
    || CONTROL_CHARACTERS.test(record.threadId)
    || utf8Bytes(record.threadId) > 512
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-scope", child(path, "threadId"));
  }
  return Object.freeze({
    sourceId: record.sourceId,
    threadId: record.threadId
  });
}

function receiptFreshness(
  value: unknown,
  path: string,
  context: ReceiptParseContext
): ReceiptCommon["freshness"] {
  const record = receiptRecord(
    value,
    ["status", "reason"],
    path,
    context
  );
  if (
    record.status !== "unassessed"
    || record.reason !== "single-read-no-head-revalidation"
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-freshness", path);
  }
  return Object.freeze({
    status: "unassessed",
    reason: "single-read-no-head-revalidation"
  });
}

function receiptCoverage(
  value: unknown,
  status: "available" | "abstained",
  path: string,
  context: ReceiptParseContext
): LocalAttunementSnapshotReceipt["coverage"] {
  const record = receiptRecord(
    value,
    [
      "status",
      "canAssertAbsenceWithinSnapshot",
      "canAssertCurrentWorldAbsence",
      "reasons"
    ],
    path,
    context
  );
  if (
    record.status !== (status === "available" ? "partial" : "abstained")
    || record.canAssertAbsenceWithinSnapshot !== false
    || record.canAssertCurrentWorldAbsence !== false
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-coverage", path);
  }
  const expected = status === "available"
    ? [
        "single-local-store",
        "requested-thread-exists",
        "point-in-time-read"
      ] as const
    : ["no-available-provider-snapshot"] as const;
  const reasons = receiptArray(
    record.reasons,
    expected,
    child(path, "reasons"),
    context
  );
  return Object.freeze({
    status: status === "available" ? "partial" : "abstained",
    canAssertAbsenceWithinSnapshot: false,
    canAssertCurrentWorldAbsence: false,
    reasons
  }) as LocalAttunementSnapshotReceipt["coverage"];
}

function parseReceiptBody(
  input: unknown
): Readonly<{
  readonly body: Omit<LocalAttunementSnapshotReceipt, "receiptId">;
  readonly receiptId: string;
}> {
  const context: ReceiptParseContext = {
    descriptors: 0,
    seen: new Set<object>()
  };
  const baseKeys = [
    "schemaVersion",
    "receiptVersion",
    "receiptId",
    "authority",
    "providerId",
    "providerVersion",
    "scope",
    "captureCompletedAt",
    "freshness"
  ] as const;
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || isProxy(input)
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-envelope", "/");
  }
  const statusDescriptor = Object.getOwnPropertyDescriptor(input, "status");
  if (statusDescriptor === undefined || !("value" in statusDescriptor)) {
    receiptFail("INVALID_RECEIPT", "invalid-field-set", "/status");
  }
  const status = statusDescriptor.value;
  const keys = status === "available"
    ? [...baseKeys, "status", "stateDigest", "normalizedStateBytes", "coverage"]
    : status === "abstained"
      ? [...baseKeys, "status", "reason", "coverage"]
      : receiptFail("INVALID_RECEIPT", "invalid-status", "/status");
  const record = receiptRecord(input, keys, "/", context);
  if (record.schemaVersion !== 1) {
    receiptFail("INVALID_RECEIPT", "invalid-schema", "/schemaVersion");
  }
  if (record.receiptVersion !== LOCAL_ATTUNEMENT_SNAPSHOT_RECEIPT_VERSION) {
    receiptFail("INVALID_RECEIPT", "invalid-version", "/receiptVersion");
  }
  if (record.authority !== "receipt-integrity-only") {
    receiptFail("INVALID_RECEIPT", "invalid-authority", "/authority");
  }
  if (record.providerId !== LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID) {
    receiptFail("INVALID_RECEIPT", "invalid-provider", "/providerId");
  }
  if (record.providerVersion !== LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION) {
    receiptFail("INVALID_RECEIPT", "invalid-provider", "/providerVersion");
  }
  if (typeof record.receiptId !== "string" || !RECEIPT_ID.test(record.receiptId)) {
    receiptFail("INVALID_RECEIPT", "receipt-integrity-mismatch", "/receiptId");
  }
  const common = {
    schemaVersion: 1 as const,
    receiptVersion: LOCAL_ATTUNEMENT_SNAPSHOT_RECEIPT_VERSION,
    authority: "receipt-integrity-only" as const,
    providerId: LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID,
    providerVersion: LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION,
    scope: receiptScope(record.scope, "/scope", context),
    captureCompletedAt: receiptInstant(
      record.captureCompletedAt,
      "/captureCompletedAt"
    ),
    freshness: receiptFreshness(record.freshness, "/freshness", context)
  };
  let body: Omit<LocalAttunementSnapshotReceipt, "receiptId">;
  if (status === "available") {
    if (typeof record.stateDigest !== "string" || !STATE_DIGEST.test(record.stateDigest)) {
      receiptFail("INVALID_RECEIPT", "invalid-digest", "/stateDigest");
    }
    if (
      typeof record.normalizedStateBytes !== "number"
      || !Number.isSafeInteger(record.normalizedStateBytes)
      || record.normalizedStateBytes < 0
      || record.normalizedStateBytes > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES
    ) {
      receiptFail("INVALID_RECEIPT", "invalid-byte-count", "/normalizedStateBytes");
    }
    body = Object.freeze({
      ...common,
      status: "available" as const,
      stateDigest: record.stateDigest,
      normalizedStateBytes: record.normalizedStateBytes,
      coverage: receiptCoverage(record.coverage, "available", "/coverage", context)
    });
  } else {
    if (
      record.reason !== "source-read-failed"
      && record.reason !== "requested-scope-unavailable"
      && record.reason !== "source-capacity-exceeded"
    ) {
      receiptFail("INVALID_RECEIPT", "invalid-abstention", "/reason");
    }
    body = Object.freeze({
      ...common,
      status: "abstained" as const,
      reason: record.reason,
      coverage: receiptCoverage(record.coverage, "abstained", "/coverage", context)
    });
  }
  const canonicalBytes = utf8Bytes(
    JSON.stringify({ ...body, receiptId: record.receiptId })
  );
  if (canonicalBytes > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RECEIPT_BYTES) {
    receiptFail(
      "RECEIPT_CAPACITY_EXCEEDED",
      "receipt-capacity-exceeded",
      "/"
    );
  }
  return Object.freeze({ body, receiptId: record.receiptId });
}

export function verifyLocalAttunementSnapshotReceiptIntegrity(
  input: unknown
): LocalAttunementSnapshotReceipt {
  const parsed = parseReceiptBody(input);
  if (receiptId(parsed.body) !== parsed.receiptId) {
    receiptFail(
      "INTEGRITY_MISMATCH",
      "receipt-integrity-mismatch",
      "/receiptId"
    );
  }
  return Object.freeze({
    ...parsed.body,
    receiptId: parsed.receiptId
  }) as LocalAttunementSnapshotReceipt;
}

type CaptureShell = Readonly<{
  readonly capture: LocalAttunementSnapshotCapture;
  readonly descriptors: Readonly<Record<string, PropertyDescriptor>>;
  readonly receipt: LocalAttunementSnapshotReceipt;
}>;

function captureShell(
  input: unknown,
  expectedOwner?: object
): CaptureShell {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || isProxy(input)
    || !mintedCaptures.has(input)
    || (
      expectedOwner !== undefined
      && captureOwners.get(input) !== expectedOwner
    )
  ) {
    receiptFail("UNTRUSTED_CAPTURE", "not-minted", "/");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (!Object.isFrozen(input)) {
    receiptFail(
      "UNTRUSTED_CAPTURE",
      "invalid-capture-descriptors",
      "/"
    );
  }
  const status = descriptors.status;
  const provenance = descriptors.provenance;
  const receiptDescriptor = descriptors.receipt;
  if (
    Object.getPrototypeOf(input) !== null
    || status === undefined
    || provenance === undefined
    || receiptDescriptor === undefined
    || !("value" in status)
    || !("value" in provenance)
    || !("value" in receiptDescriptor)
    || status.enumerable !== true
    || provenance.enumerable !== true
    || receiptDescriptor.enumerable !== true
    || status.writable !== false
    || provenance.writable !== false
    || receiptDescriptor.writable !== false
    || status.configurable !== false
    || provenance.configurable !== false
    || receiptDescriptor.configurable !== false
  ) {
    receiptFail(
      "UNTRUSTED_CAPTURE",
      "invalid-capture-descriptors",
      "/"
    );
  }
  const receipt = verifyLocalAttunementSnapshotReceiptIntegrity(
    receiptDescriptor.value
  );
  if (status.value === "available") {
    const state = descriptors.normalizedStateJson;
    const expectedKeys = [
      "status",
      "provenance",
      "receipt",
      "normalizedStateJson"
    ];
    if (
      Reflect.ownKeys(input).some((key) => typeof key !== "string")
      || Reflect.ownKeys(input).length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(input, key))
      || provenance.value !== "provider-observed-configured-local-snapshot"
      || receipt.status !== "available"
      || state === undefined
      || !("value" in state)
      || state.enumerable !== false
      || state.writable !== false
      || state.configurable !== false
    ) {
      receiptFail(
        "UNTRUSTED_CAPTURE",
        "invalid-capture-descriptors",
        "/normalizedStateJson"
      );
    }
  } else if (status.value === "abstained") {
    if (
      Reflect.ownKeys(input).length !== 3
      || Object.hasOwn(input, "normalizedStateJson")
      || provenance.value !== "provider-attempted-configured-local-snapshot"
      || receipt.status !== "abstained"
    ) {
      receiptFail(
        "UNTRUSTED_CAPTURE",
        "invalid-capture-descriptors",
        "/"
      );
    }
  } else {
    receiptFail(
      "UNTRUSTED_CAPTURE",
      "invalid-capture-descriptors",
      "/status"
    );
  }
  return Object.freeze({
    capture: input as LocalAttunementSnapshotCapture,
    descriptors,
    receipt
  });
}

/** Package-private owner shell seam; intentionally absent from export maps. */
export function verifyMintedLocalAttunementSnapshotCaptureShellForTesting(
  provider: LocalAttunementSnapshotProvider,
  input: unknown
): LocalAttunementSnapshotCapture {
  const owner = providerOwners.get(provider);
  if (owner === undefined) {
    receiptFail("UNTRUSTED_CAPTURE", "not-minted", "/");
  }
  return captureShell(input, owner).capture;
}

export function verifyMintedLocalAttunementSnapshotCapture(
  input: unknown
): VerifiedMintedLocalAttunementSnapshotCapture {
  const shell = captureShell(input);
  if (shell.capture.status === "available") {
    const state = shell.descriptors.normalizedStateJson;
    if (
      state === undefined
      || !("value" in state)
      || typeof state.value !== "string"
    ) {
      receiptFail(
        "UNTRUSTED_CAPTURE",
        "invalid-capture-descriptors",
        "/normalizedStateJson"
      );
    }
    const bytes = utf8Bytes(state.value);
    if (
      bytes > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES
      || bytes !== shell.capture.receipt.normalizedStateBytes
    ) {
      receiptFail(
        "UNTRUSTED_CAPTURE",
        "state-capacity-exceeded",
        "/normalizedStateJson"
      );
    }
    if (sha256(state.value) !== shell.capture.receipt.stateDigest) {
      receiptFail(
        "UNTRUSTED_CAPTURE",
        "state-digest-mismatch",
        "/normalizedStateJson"
      );
    }
  }
  return input as VerifiedMintedLocalAttunementSnapshotCapture;
}

function mintAvailableCapture(
  receipt: LocalAttunementSnapshotReceiptV1,
  normalizedStateJson: string,
  owner: object
): LocalAttunementSnapshotCapture {
  const capture = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(capture, {
    status: {
      configurable: false,
      enumerable: true,
      value: "available",
      writable: false
    },
    provenance: {
      configurable: false,
      enumerable: true,
      value: "provider-observed-configured-local-snapshot",
      writable: false
    },
    receipt: {
      configurable: false,
      enumerable: true,
      value: receipt,
      writable: false
    },
    normalizedStateJson: {
      configurable: false,
      enumerable: false,
      value: normalizedStateJson,
      writable: false
    }
  });
  Object.freeze(capture);
  mintedCaptures.add(capture);
  captureOwners.set(capture, owner);
  return capture as LocalAttunementSnapshotCapture;
}

function mintAbstainedCapture(
  receipt: LocalAttunementSnapshotAbstentionReceiptV1,
  owner: object
): LocalAttunementSnapshotCapture {
  const capture = Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      status: "abstained",
      provenance: "provider-attempted-configured-local-snapshot",
      receipt
    })
  );
  mintedCaptures.add(capture);
  captureOwners.set(capture, owner);
  return capture as LocalAttunementSnapshotCapture;
}

async function captureSnapshot(
  file: string,
  sourceId: string,
  dependencies: ProviderDependencies,
  owner: object,
  input: unknown
): Promise<LocalAttunementSnapshotCapture> {
  const scope = parseScope(input, sourceId);
  let readAttempt: unknown;
  try {
    readAttempt = await dependencies.readState(file);
  } catch {
    readAttempt = Object.freeze({ status: "io-failed" as const });
  }
  const read = boundedReadDisposition(readAttempt);
  if (read.status !== "available") {
    const reason = read.status === "capacity"
      ? "source-capacity-exceeded"
      : read.status === "missing"
        ? "requested-scope-unavailable"
        : "source-read-failed";
    const receipt = abstentionReceipt(
      scope,
      captureCompletedAt(dependencies.clock),
      reason
    );
    try {
      verifyLocalAttunementSnapshotReceiptIntegrity(receipt);
    } catch {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "receipt-postcondition-failed",
        "/receipt"
      );
    }
    const capture = mintAbstainedCapture(receipt, owner);
    try {
      verifyMintedLocalAttunementSnapshotCapture(capture);
    } catch {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "receipt-postcondition-failed",
        "/receipt"
      );
    }
    return capture;
  }
  const normalizedStateJson = canonicalStateJson(read.state);
  if (
    utf8Bytes(normalizedStateJson)
    > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES
  ) {
    const receipt = abstentionReceipt(
      scope,
      captureCompletedAt(dependencies.clock),
      "source-capacity-exceeded"
    );
    const capture = mintAbstainedCapture(receipt, owner);
    try {
      verifyMintedLocalAttunementSnapshotCapture(capture);
    } catch {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "receipt-postcondition-failed",
        "/receipt"
      );
    }
    return capture;
  }
  if (!read.state.threads.some((thread) => thread.id === scope.threadId)) {
    const receipt = abstentionReceipt(
      scope,
      captureCompletedAt(dependencies.clock),
      "requested-scope-unavailable"
    );
    const capture = mintAbstainedCapture(receipt, owner);
    try {
      verifyMintedLocalAttunementSnapshotCapture(capture);
    } catch {
      providerFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "receipt-postcondition-failed",
        "/receipt"
      );
    }
    return capture;
  }
  const receipt = availableReceipt(
    scope,
    captureCompletedAt(dependencies.clock),
    normalizedStateJson
  );
  try {
    verifyLocalAttunementSnapshotReceiptIntegrity(receipt);
  } catch {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "receipt-postcondition-failed",
      "/receipt"
    );
  }
  const capture = mintAvailableCapture(receipt, normalizedStateJson, owner);
  try {
    verifyMintedLocalAttunementSnapshotCapture(capture);
  } catch {
    providerFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "receipt-postcondition-failed",
      "/receipt"
    );
  }
  return capture;
}

function createProvider(
  options: LocalAttunementSnapshotProviderOptions,
  dependenciesOverride?: Partial<ProviderDependencies>
): LocalAttunementSnapshotProvider {
  const parsed = parseOptions(options);
  const owner = Object.freeze(Object.create(null) as object);
  const dependencies: ProviderDependencies = Object.freeze({
    readState: dependenciesOverride?.readState ?? readBoundedAttunementState,
    clock: dependenciesOverride?.clock ?? parsed.clock ?? (() => new Date())
  });
  const capture = (scope: unknown): Promise<LocalAttunementSnapshotCapture> =>
    captureSnapshot(
      parsed.attunementFile,
      parsed.sourceId,
      dependencies,
      owner,
      scope
    );
  const captureHeadRevalidation = bindProviderOwnedHeadRevalidation(
    capture,
    (input) => captureShell(input, owner).capture,
    verifyMintedLocalAttunementSnapshotCapture
  );
  const provider = Object.freeze({
    providerId: LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_ID,
    providerVersion: LOCAL_ATTUNEMENT_SNAPSHOT_PROVIDER_VERSION,
    sourceId: parsed.sourceId,
    capture,
    captureHeadRevalidation
  });
  providerOwners.set(provider, owner);
  return provider;
}

export function createLocalAttunementSnapshotProvider(
  options: LocalAttunementSnapshotProviderOptions
): LocalAttunementSnapshotProvider {
  return createProvider(options);
}

/** Package-private test seam; intentionally absent from every export map. */
export function createLocalAttunementSnapshotProviderForTesting(
  options: LocalAttunementSnapshotProviderOptions,
  dependencies: Partial<ProviderDependencies>
): LocalAttunementSnapshotProvider {
  return createProvider(options, dependencies);
}
