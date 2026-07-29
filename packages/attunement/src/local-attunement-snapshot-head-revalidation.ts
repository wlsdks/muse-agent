import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type {
  LocalAttunementSnapshotAbstentionReason,
  LocalAttunementSnapshotCapture,
  LocalAttunementSnapshotProvider,
  LocalAttunementSnapshotReceiptV1,
  LocalAttunementSnapshotScope,
  VerifiedMintedLocalAttunementSnapshotCapture
} from "./local-attunement-snapshot-provider.js";

const RECEIPT_DOMAIN =
  "muse.attunement.local-snapshot-head-revalidation-receipt.v1";
const RECEIPT_PREFIX =
  "muse-local-attunement-head-revalidation:sha256:";
const RECEIPT_ID =
  /^muse-local-attunement-head-revalidation:sha256:[0-9a-f]{64}$/u;
const PROVIDER_ID = "muse.local-attunement-store";
const PROVIDER_VERSION =
  "muse.local-attunement-snapshot-provider.v1";
const MAX_CAPTURE_SPAN_MS = 30_000;

type CaptureIdentityVerifier = (
  input: unknown
) => LocalAttunementSnapshotCapture;

type CaptureIntegrityVerifier = (
  input: unknown
) => VerifiedMintedLocalAttunementSnapshotCapture;

type RevalidationVerificationContext = Readonly<{
  readonly verifyIdentity: CaptureIdentityVerifier;
  readonly verifyIntegrity: CaptureIntegrityVerifier;
}>;

type EndpointReceipt = Readonly<{
  readonly providerReceiptId: string;
  readonly stateDigest: string;
  readonly normalizedStateBytes: number;
  readonly captureCompletedAt: string;
}>;

type ReceiptCommon = Readonly<{
  readonly schemaVersion: 1;
  readonly receiptVersion:
    "muse.local-attunement-snapshot-head-revalidation-receipt.v1";
  readonly receiptId: string;
  readonly authority: "receipt-integrity-only";
  readonly providerId: "muse.local-attunement-store";
  readonly providerVersion:
    "muse.local-attunement-snapshot-provider.v1";
  readonly providerScope: LocalAttunementSnapshotScope;
  readonly maxCaptureSpanMs: number;
  readonly canAssertFreshAtAssessment: boolean;
  readonly canAssertAbsenceWithinSnapshot: false;
  readonly canAssertCurrentWorldAbsence: false;
  readonly canAssertDurableProviderAuthority: false;
  readonly mintVerificationSurvivesSerialization: false;
}>;

export type LocalAttunementSnapshotHeadRevalidationReceiptV1 =
  | ReceiptCommon & Readonly<{
      readonly status: "abstained";
      readonly stage: "provider";
      readonly reason: LocalAttunementSnapshotAbstentionReason;
      readonly subjectAbstentionReceiptId: string;
      readonly mintVerification:
        "provider-owned-revalidation-artifact-verified-in-composing-process";
    }>
  | ReceiptCommon & Readonly<{
      readonly status: "abstained";
      readonly stage: "revalidation";
      readonly reason: LocalAttunementSnapshotAbstentionReason;
      readonly subject: EndpointReceipt;
      readonly headAbstentionReceiptId: string;
      readonly mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process";
    }>
  | ReceiptCommon & Readonly<{
      readonly status: "fresh" | "stale";
      readonly stage: "revalidation";
      readonly reason:
        | "head-state-matched-within-bound"
        | "head-state-changed"
        | "capture-span-exceeded";
      readonly captureSpanMs: number;
      readonly subject: EndpointReceipt;
      readonly head: EndpointReceipt;
      readonly mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process";
    }>;

export type LocalAttunementSnapshotHeadRevalidation =
  Readonly<{
    readonly status: "fresh" | "stale" | "abstained";
    readonly receipt: LocalAttunementSnapshotHeadRevalidationReceiptV1;
    readonly subjectCapture: LocalAttunementSnapshotCapture;
    readonly headCapture?: LocalAttunementSnapshotCapture;
  }>;

declare const VERIFIED_HEAD_REVALIDATION: unique symbol;
export type VerifiedMintedLocalAttunementSnapshotHeadRevalidation =
  LocalAttunementSnapshotHeadRevalidation & {
    readonly [VERIFIED_HEAD_REVALIDATION]: true;
  };

export type LocalAttunementSnapshotHeadRevalidationErrorCode =
  | "INVALID_OPTIONS"
  | "UNTRUSTED_REVALIDATION"
  | "INTERNAL_POSTCONDITION_FAILED";

export type LocalAttunementSnapshotHeadRevalidationErrorReason =
  | "invalid-options-envelope"
  | "invalid-max-capture-span-ms"
  | "not-minted"
  | "invalid-artifact-descriptors"
  | "capture-not-minted"
  | "same-capture-reused"
  | "provider-mismatch"
  | "scope-mismatch"
  | "time-reversal"
  | "capture-integrity-mismatch"
  | "receipt-integrity-mismatch"
  | "classification-mismatch";

export class LocalAttunementSnapshotHeadRevalidationError extends Error {
  readonly code: LocalAttunementSnapshotHeadRevalidationErrorCode;
  readonly details: Readonly<{
    readonly path: string;
    readonly reason: LocalAttunementSnapshotHeadRevalidationErrorReason;
  }>;

  constructor(
    code: LocalAttunementSnapshotHeadRevalidationErrorCode,
    reason: LocalAttunementSnapshotHeadRevalidationErrorReason,
    path: string
  ) {
    super("local-attunement-snapshot-head-revalidation-failed");
    this.name = "LocalAttunementSnapshotHeadRevalidationError";
    this.code = code;
    this.details = Object.freeze({ path: path.slice(0, 512), reason });
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

const mintedRevalidations =
  new WeakMap<object, RevalidationVerificationContext>();

function fail(
  code: LocalAttunementSnapshotHeadRevalidationErrorCode,
  reason: LocalAttunementSnapshotHeadRevalidationErrorReason,
  path: string
): never {
  throw new LocalAttunementSnapshotHeadRevalidationError(code, reason, path);
}

function freezeRecord<T extends Record<string, unknown>>(
  value: T
): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function sameScope(
  left: LocalAttunementSnapshotScope,
  right: LocalAttunementSnapshotScope
): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function endpoint(
  receipt: LocalAttunementSnapshotReceiptV1
): EndpointReceipt {
  return freezeRecord({
    providerReceiptId: receipt.receiptId,
    stateDigest: receipt.stateDigest,
    normalizedStateBytes: receipt.normalizedStateBytes,
    captureCompletedAt: receipt.captureCompletedAt
  });
}

function parseMaxCaptureSpanMs(input: unknown): number {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || nodeTypes.isProxy(input)
    || (
      Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null
    )
  ) {
    fail("INVALID_OPTIONS", "invalid-options-envelope", "/options");
  }
  const keys = Reflect.ownKeys(input);
  const descriptor = Reflect.getOwnPropertyDescriptor(
    input,
    "maxCaptureSpanMs"
  );
  if (
    keys.length !== 1
    || keys[0] !== "maxCaptureSpanMs"
    || descriptor === undefined
    || !("value" in descriptor)
  ) {
    fail("INVALID_OPTIONS", "invalid-options-envelope", "/options");
  }
  const value = descriptor.value;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_CAPTURE_SPAN_MS
  ) {
    fail(
      "INVALID_OPTIONS",
      "invalid-max-capture-span-ms",
      "/options/maxCaptureSpanMs"
    );
  }
  return value;
}

function receiptId(body: object): string {
  const digest = createHash("sha256")
    .update(RECEIPT_DOMAIN, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return `${RECEIPT_PREFIX}${digest}`;
}

function commonReceipt(
  providerScope: LocalAttunementSnapshotScope,
  maxCaptureSpanMs: number,
  canAssertFreshAtAssessment: boolean
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptVersion:
      "muse.local-attunement-snapshot-head-revalidation-receipt.v1",
    authority: "receipt-integrity-only",
    providerId: PROVIDER_ID,
    providerVersion: PROVIDER_VERSION,
    providerScope,
    maxCaptureSpanMs,
    canAssertFreshAtAssessment,
    canAssertAbsenceWithinSnapshot: false,
    canAssertCurrentWorldAbsence: false,
    canAssertDurableProviderAuthority: false,
    mintVerificationSurvivesSerialization: false
  };
}

function sealReceipt(
  body: Record<string, unknown>
): LocalAttunementSnapshotHeadRevalidationReceiptV1 {
  return freezeRecord({
    ...body,
    receiptId: receiptId(body)
  }) as LocalAttunementSnapshotHeadRevalidationReceiptV1;
}

function mintArtifact(
  receipt: LocalAttunementSnapshotHeadRevalidationReceiptV1,
  subjectCapture: LocalAttunementSnapshotCapture,
  verification: RevalidationVerificationContext,
  headCapture?: LocalAttunementSnapshotCapture
): LocalAttunementSnapshotHeadRevalidation {
  const artifact = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(artifact, {
    status: {
      configurable: false,
      enumerable: true,
      value: receipt.status,
      writable: false
    },
    receipt: {
      configurable: false,
      enumerable: true,
      value: receipt,
      writable: false
    },
    subjectCapture: {
      configurable: false,
      enumerable: false,
      value: subjectCapture,
      writable: false
    },
    ...(headCapture === undefined
      ? {}
      : {
          headCapture: {
            configurable: false,
            enumerable: false,
            value: headCapture,
            writable: false
          }
        })
  });
  Object.freeze(artifact);
  mintedRevalidations.set(artifact, verification);
  return artifact as LocalAttunementSnapshotHeadRevalidation;
}

function verifiedCapture<T extends LocalAttunementSnapshotCapture>(
  verifyCapture: (input: unknown) => T,
  input: unknown,
  path: string
): T {
  try {
    return verifyCapture(input);
  } catch {
    fail("UNTRUSTED_REVALIDATION", "capture-not-minted", path);
  }
}

function assertCaptureOwnerAndScope(
  capture: LocalAttunementSnapshotCapture,
  scope: LocalAttunementSnapshotScope,
  path: string
): void {
  if (
    capture.receipt.providerId !== PROVIDER_ID
    || capture.receipt.providerVersion !== PROVIDER_VERSION
  ) {
    fail("UNTRUSTED_REVALIDATION", "provider-mismatch", path);
  }
  if (!sameScope(capture.receipt.scope, scope)) {
    fail("UNTRUSTED_REVALIDATION", "scope-mismatch", path);
  }
}

function captureState(
  capture: Extract<
    VerifiedMintedLocalAttunementSnapshotCapture,
    { readonly status: "available" }
  >,
  path: string
): string {
  const descriptor = Reflect.getOwnPropertyDescriptor(
    capture,
    "normalizedStateJson"
  );
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
  ) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "capture-integrity-mismatch",
      path
    );
  }
  const normalizedStateJson = descriptor.value;
  if (
    Buffer.byteLength(normalizedStateJson, "utf8")
      !== capture.receipt.normalizedStateBytes
    || sha256(normalizedStateJson) !== capture.receipt.stateDigest
  ) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "capture-integrity-mismatch",
      path
    );
  }
  return normalizedStateJson;
}

function endpointStatesEqual(input: Readonly<{
  readonly subjectBytes: number;
  readonly headBytes: number;
  readonly subjectDigest: string;
  readonly headDigest: string;
  readonly subjectStateJson: string;
  readonly headStateJson: string;
}>): boolean {
  return input.subjectBytes === input.headBytes
    && input.subjectDigest === input.headDigest
    && input.subjectStateJson === input.headStateJson;
}

/** Package-private collision seam; intentionally absent from export maps. */
export function providerHeadEndpointStatesEqualForTesting(
  input: Parameters<typeof endpointStatesEqual>[0]
): boolean {
  return endpointStatesEqual(input);
}

function baseReceiptBody(
  scope: LocalAttunementSnapshotScope,
  maxCaptureSpanMs: number,
  canAssertFreshAtAssessment: boolean
): Record<string, unknown> {
  return commonReceipt(
    freezeRecord({
      sourceId: scope.sourceId,
      threadId: scope.threadId
    }),
    maxCaptureSpanMs,
    canAssertFreshAtAssessment
  );
}

export function bindProviderOwnedHeadRevalidation(
  capture: LocalAttunementSnapshotProvider["capture"],
  verifyIdentity: CaptureIdentityVerifier,
  verifyIntegrity: CaptureIntegrityVerifier
): LocalAttunementSnapshotProvider["captureHeadRevalidation"] {
  const verification = Object.freeze({
    verifyIdentity,
    verifyIntegrity
  });
  return async (scope, options) => {
    // Parse to a primitive before the first read; no caller-owned object is
    // retained across either capture.
    const maxCaptureSpanMs = parseMaxCaptureSpanMs(options);
    const subjectShell = verifiedCapture(
      verifyIdentity,
      await capture(scope),
      "/subjectCapture"
    );
    const providerScope = subjectShell.receipt.scope;
    assertCaptureOwnerAndScope(
      subjectShell,
      providerScope,
      "/subjectCapture"
    );
    if (subjectShell.status === "abstained") {
      const subject = verifiedCapture(
        verifyIntegrity,
        subjectShell,
        "/subjectCapture"
      );
      if (subject.status !== "abstained") {
        fail(
          "UNTRUSTED_REVALIDATION",
          "classification-mismatch",
          "/subjectCapture"
        );
      }
      return mintArtifact(
        sealReceipt({
          ...baseReceiptBody(
            providerScope,
            maxCaptureSpanMs,
            false
          ),
          status: "abstained",
          stage: "provider",
          reason: subject.receipt.reason,
          subjectAbstentionReceiptId: subject.receipt.receiptId,
          mintVerification:
            "provider-owned-revalidation-artifact-verified-in-composing-process"
        }),
        subject,
        verification
      );
    }

    const headShell = verifiedCapture(
      verifyIdentity,
      await capture(providerScope),
      "/headCapture"
    );
    if (subjectShell === headShell) {
      fail(
        "UNTRUSTED_REVALIDATION",
        "same-capture-reused",
        "/headCapture"
      );
    }
    assertCaptureOwnerAndScope(headShell, providerScope, "/headCapture");
    // Both process-local mint/owner/scope shells are proven before the full
    // integrity verifier can inspect either hidden normalized state.
    const subject = verifiedCapture(
      verifyIntegrity,
      subjectShell,
      "/subjectCapture"
    );
    const head = verifiedCapture(
      verifyIntegrity,
      headShell,
      "/headCapture"
    );
    if (
      subject.status !== "available"
      || head.status !== headShell.status
    ) {
      fail(
        "UNTRUSTED_REVALIDATION",
        "classification-mismatch",
        "/headCapture"
      );
    }
    if (head.status === "abstained") {
      return mintArtifact(
        sealReceipt({
          ...baseReceiptBody(
            providerScope,
            maxCaptureSpanMs,
            false
          ),
          status: "abstained",
          stage: "revalidation",
          reason: head.receipt.reason,
          subject: endpoint(subject.receipt),
          headAbstentionReceiptId: head.receipt.receiptId,
          mintVerification:
            "provider-owned-two-capture-pair-verified-in-composing-process"
        }),
        subject,
        verification,
        head
      );
    }

    // Mint verification of both endpoint captures occurs above, before these
    // non-enumerable normalized-state descriptors are accessed.
    const subjectState = captureState(subject, "/subjectCapture");
    const headState = captureState(head, "/headCapture");
    const captureSpanMs =
      Date.parse(head.receipt.captureCompletedAt)
      - Date.parse(subject.receipt.captureCompletedAt);
    if (captureSpanMs < 0) {
      fail(
        "UNTRUSTED_REVALIDATION",
        "time-reversal",
        "/headCapture/receipt/captureCompletedAt"
      );
    }
    const statesEqual = endpointStatesEqual({
      subjectBytes: subject.receipt.normalizedStateBytes,
      headBytes: head.receipt.normalizedStateBytes,
      subjectDigest: subject.receipt.stateDigest,
      headDigest: head.receipt.stateDigest,
      subjectStateJson: subjectState,
      headStateJson: headState
    });
    const reason = !statesEqual
      ? "head-state-changed"
      : captureSpanMs > maxCaptureSpanMs
        ? "capture-span-exceeded"
        : "head-state-matched-within-bound";
    const status = reason === "head-state-matched-within-bound"
      ? "fresh"
      : "stale";
    const receipt = sealReceipt({
      ...baseReceiptBody(
        providerScope,
        maxCaptureSpanMs,
        status === "fresh"
      ),
      status,
      stage: "revalidation",
      reason,
      captureSpanMs,
      subject: endpoint(subject.receipt),
      head: endpoint(head.receipt),
      mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process"
    });
    return mintArtifact(receipt, subject, verification, head);
  };
}

function verifyReceiptId(
  receipt: LocalAttunementSnapshotHeadRevalidationReceiptV1
): void {
  if (!RECEIPT_ID.test(receipt.receiptId)) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "receipt-integrity-mismatch",
      "/receipt/receiptId"
    );
  }
  const { receiptId: actual, ...body } = receipt;
  if (receiptId(body) !== actual) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "receipt-integrity-mismatch",
      "/receipt/receiptId"
    );
  }
}

export function verifyMintedLocalAttunementSnapshotHeadRevalidation(
  input: unknown
): VerifiedMintedLocalAttunementSnapshotHeadRevalidation {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || nodeTypes.isProxy(input)
    || !mintedRevalidations.has(input)
  ) {
    fail("UNTRUSTED_REVALIDATION", "not-minted", "/");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const status = descriptors.status;
  const receiptDescriptor = descriptors.receipt;
  const subjectDescriptor = descriptors.subjectCapture;
  const headDescriptor = descriptors.headCapture;
  if (
    Object.getPrototypeOf(input) !== null
    || !Object.isFrozen(input)
    || status === undefined
    || receiptDescriptor === undefined
    || subjectDescriptor === undefined
    || !("value" in status)
    || !("value" in receiptDescriptor)
    || !("value" in subjectDescriptor)
    || status.enumerable !== true
    || receiptDescriptor.enumerable !== true
    || subjectDescriptor.enumerable !== false
  ) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "invalid-artifact-descriptors",
      "/"
    );
  }
  const verification = mintedRevalidations.get(input);
  if (verification === undefined) {
    fail("UNTRUSTED_REVALIDATION", "not-minted", "/");
  }
  const subjectShell = verifiedCapture(
    verification.verifyIdentity,
    subjectDescriptor.value,
    "/subjectCapture"
  );
  const headShell = headDescriptor && "value" in headDescriptor
    ? verifiedCapture(
        verification.verifyIdentity,
        headDescriptor.value,
        "/headCapture"
      )
    : undefined;
  if (headShell !== undefined && subjectShell === headShell) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "same-capture-reused",
      "/headCapture"
    );
  }
  const receipt =
    receiptDescriptor.value as LocalAttunementSnapshotHeadRevalidationReceiptV1;
  verifyReceiptId(receipt);
  assertCaptureOwnerAndScope(
    subjectShell,
    receipt.providerScope,
    "/subjectCapture"
  );
  if (headShell !== undefined) {
    assertCaptureOwnerAndScope(
      headShell,
      receipt.providerScope,
      "/headCapture"
    );
  }
  if (
    status.value !== receipt.status
    || (
      receipt.stage === "provider"
      ? subjectShell.status !== "abstained" || headShell !== undefined
      : subjectShell.status !== "available" || headShell === undefined
    )
  ) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "classification-mismatch",
      "/receipt"
    );
  }
  const expectedMintVerification = receipt.stage === "provider"
    ? "provider-owned-revalidation-artifact-verified-in-composing-process"
    : "provider-owned-two-capture-pair-verified-in-composing-process";
  if (
    receipt.mintVerification !== expectedMintVerification
    || receipt.mintVerificationSurvivesSerialization !== false
  ) {
    fail(
      "UNTRUSTED_REVALIDATION",
      "classification-mismatch",
      "/receipt/mintVerification"
    );
  }
  // Only after the artifact mint and every present endpoint owner/scope shell
  // agree may either full verifier inspect hidden normalized state.
  const subject = verifiedCapture(
    verification.verifyIntegrity,
    subjectShell,
    "/subjectCapture"
  );
  const head = headShell === undefined
    ? undefined
    : verifiedCapture(
        verification.verifyIntegrity,
        headShell,
        "/headCapture"
      );
  if (
    receipt.stage === "revalidation"
    && receipt.status !== "abstained"
    && subject.status === "available"
    && head?.status === "available"
  ) {
    const subjectState = captureState(subject, "/subjectCapture");
    const headState = captureState(head, "/headCapture");
    const span =
      Date.parse(head.receipt.captureCompletedAt)
      - Date.parse(subject.receipt.captureCompletedAt);
    if (span < 0) {
      fail(
        "UNTRUSTED_REVALIDATION",
        "time-reversal",
        "/headCapture/receipt/captureCompletedAt"
      );
    }
    const equal = endpointStatesEqual({
      subjectBytes: subject.receipt.normalizedStateBytes,
      headBytes: head.receipt.normalizedStateBytes,
      subjectDigest: subject.receipt.stateDigest,
      headDigest: head.receipt.stateDigest,
      subjectStateJson: subjectState,
      headStateJson: headState
    });
    const expectedReason = !equal
      ? "head-state-changed"
      : span > receipt.maxCaptureSpanMs
        ? "capture-span-exceeded"
        : "head-state-matched-within-bound";
    if (
      receipt.captureSpanMs !== span
      || receipt.reason !== expectedReason
      || receipt.status
        !== (
          expectedReason === "head-state-matched-within-bound"
            ? "fresh"
            : "stale"
        )
      || receipt.canAssertFreshAtAssessment
        !== (receipt.status === "fresh")
    ) {
      fail(
        "UNTRUSTED_REVALIDATION",
        "classification-mismatch",
        "/receipt"
      );
    }
  }
  return input as VerifiedMintedLocalAttunementSnapshotHeadRevalidation;
}
