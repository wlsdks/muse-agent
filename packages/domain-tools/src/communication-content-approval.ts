import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

export const COMMUNICATION_CONTENT_APPROVAL_VERSION =
  "muse.communication-content-approval/v1" as const;

const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface CommunicationAttachmentContent {
  readonly attachmentId: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mediaType: string;
}

export interface CommunicationContent {
  readonly attachments: readonly CommunicationAttachmentContent[];
  readonly channel: string;
  readonly destination: string;
  readonly effectId: string;
  readonly text: string;
}

export interface CommunicationContentApprovalBinding {
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly authenticator: string;
  readonly attachments: readonly Readonly<{
    attachmentId: string;
    byteLength: number;
    contentSha256: string;
    fileName: string;
    mediaType: string;
    order: number;
  }>[];
  readonly channel: string;
  readonly contentDigest: string;
  readonly destination: string;
  readonly effectId: string;
  readonly expiresAt: string;
  readonly schemaVersion: typeof COMMUNICATION_CONTENT_APPROVAL_VERSION;
  readonly textByteLength: number;
}

export type BindCommunicationContentApprovalResult =
  | Readonly<{
      binding: CommunicationContentApprovalBinding;
      status: "bound";
    }>
  | Readonly<{
      reason: "invalid-input" | "invalid-lifetime";
      status: "held";
    }>;

export type VerifyCommunicationContentApprovalResult =
  | Readonly<{
      canSend: true;
      contentDigest: string;
      status: "authorized";
    }>
  | Readonly<{
      canSend: false;
      reason: "content-changed" | "expired" | "invalid-approval" | "invalid-input";
      status: "held";
    }>;

/**
 * Bind the exact communication payload after a trusted owner-approval surface
 * confirms it. The returned object is a portable receipt, not permission by
 * itself: the final effect path must receive it from its approval authority and
 * call `verifyCommunicationContentApproval` immediately before dispatch.
 */
export function bindCommunicationContentApproval(input: {
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly authorityKey: Uint8Array;
  readonly content: CommunicationContent;
  readonly expiresAt: string;
}): BindCommunicationContentApprovalResult {
  try {
    const root = exactDataRecord(input, [
      "approvalId",
      "approvedAt",
      "authorityKey",
      "content",
      "expiresAt"
    ]);
    if (!root) return heldBind("invalid-input");
    const approvalId = exactText(root["approvalId"]);
    const approvedAt = canonicalInstant(root["approvedAt"]);
    const authorityKey = exactAuthorityKey(root["authorityKey"]);
    const expiresAt = canonicalInstant(root["expiresAt"]);
    const content = snapshotContent(root["content"]);
    if (!approvalId || !approvedAt || !authorityKey || !expiresAt || !content) {
      return heldBind("invalid-input");
    }
    if (Date.parse(approvedAt) >= Date.parse(expiresAt)) {
      return heldBind("invalid-lifetime");
    }
    const unsigned = {
      approvalId,
      approvedAt,
      ...content,
      expiresAt,
      schemaVersion: COMMUNICATION_CONTENT_APPROVAL_VERSION
    } as const;
    const binding = freezeBinding({
      ...unsigned,
      authenticator: authenticateBinding(unsigned, authorityKey)
    });
    return Object.freeze({ binding, status: "bound" as const });
  } catch {
    return heldBind("invalid-input");
  }
}

/**
 * Recompute the candidate payload at the last safe moment. A changed text,
 * attachment byte, attachment metadata, or attachment order invalidates the
 * approval before a provider can be called.
 */
export function verifyCommunicationContentApproval(input: {
  readonly approval: CommunicationContentApprovalBinding;
  readonly authorityKey: Uint8Array;
  readonly candidate: CommunicationContent;
  readonly now: string;
}): VerifyCommunicationContentApprovalResult {
  try {
    const root = exactDataRecord(input, ["approval", "authorityKey", "candidate", "now"]);
    if (!root) return heldVerify("invalid-input");
    const now = canonicalInstant(root["now"]);
    const authorityKey = exactAuthorityKey(root["authorityKey"]);
    const approval = parseBinding(root["approval"]);
    const candidate = snapshotContent(root["candidate"]);
    if (!now || !authorityKey || !approval || !candidate) return heldVerify("invalid-input");
    const expectedAuthenticator = authenticateBinding(unsignedBinding(approval), authorityKey);
    if (!safeEqualHex(approval.authenticator, expectedAuthenticator)) {
      return heldVerify("invalid-approval");
    }
    if (Date.parse(now) < Date.parse(approval.approvedAt)
      || Date.parse(now) >= Date.parse(approval.expiresAt)) {
      return heldVerify("expired");
    }
    if (
      approval.effectId !== candidate.effectId
      || approval.channel !== candidate.channel
      || approval.destination !== candidate.destination
      || approval.contentDigest !== candidate.contentDigest
    ) {
      return heldVerify("content-changed");
    }
    return Object.freeze({
      canSend: true,
      contentDigest: candidate.contentDigest,
      status: "authorized" as const
    });
  } catch {
    return heldVerify("invalid-input");
  }
}

interface ContentSnapshot {
  readonly attachments: CommunicationContentApprovalBinding["attachments"];
  readonly channel: string;
  readonly contentDigest: string;
  readonly destination: string;
  readonly effectId: string;
  readonly textByteLength: number;
}

function snapshotContent(value: unknown): ContentSnapshot | undefined {
  const record = exactDataRecord(value, [
    "attachments",
    "channel",
    "destination",
    "effectId",
    "text"
  ]);
  if (!record) return undefined;
  const attachments = exactDataArray(record["attachments"]);
  const channel = exactText(record["channel"]);
  const destination = exactText(record["destination"]);
  const effectId = exactText(record["effectId"]);
  const text = typeof record["text"] === "string" ? record["text"] : undefined;
  if (!attachments || !channel || !destination || !effectId || text === undefined) {
    return undefined;
  }
  if (attachments.length > MAX_ATTACHMENTS) return undefined;

  let totalBytes = 0;
  const attachmentSnapshots: Array<CommunicationContentApprovalBinding["attachments"][number]> = [];
  const attachmentIds = new Set<string>();
  for (const [order, rawAttachment] of attachments.entries()) {
    const attachment = exactDataRecord(rawAttachment, [
      "attachmentId",
      "bytes",
      "fileName",
      "mediaType"
    ]);
    if (!attachment) return undefined;
    const attachmentId = exactText(attachment["attachmentId"]);
    const fileName = exactText(attachment["fileName"]);
    const mediaType = exactText(attachment["mediaType"]);
    const bytes = exactBytes(attachment["bytes"]);
    if (!attachmentId || !fileName || !mediaType || !bytes || attachmentIds.has(attachmentId)) {
      return undefined;
    }
    attachmentIds.add(attachmentId);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return undefined;
    }
    attachmentSnapshots.push(Object.freeze({
      attachmentId,
      byteLength: bytes.byteLength,
      contentSha256: sha256(bytes),
      fileName,
      mediaType,
      order
    }));
  }
  const frozenAttachments = Object.freeze(attachmentSnapshots);
  const digestPayload = {
    attachments: frozenAttachments,
    channel,
    destination,
    effectId,
    text,
    version: COMMUNICATION_CONTENT_APPROVAL_VERSION
  };
  return {
    attachments: frozenAttachments,
    channel,
    contentDigest: sha256(Buffer.from(JSON.stringify(digestPayload), "utf8")),
    destination,
    effectId,
    textByteLength: Buffer.byteLength(text, "utf8")
  };
}

function parseBinding(value: unknown): CommunicationContentApprovalBinding | undefined {
  const record = exactDataRecord(value, [
    "approvalId",
    "approvedAt",
    "authenticator",
    "attachments",
    "channel",
    "contentDigest",
    "destination",
    "effectId",
    "expiresAt",
    "schemaVersion",
    "textByteLength"
  ]);
  if (!record || record["schemaVersion"] !== COMMUNICATION_CONTENT_APPROVAL_VERSION) {
    return undefined;
  }
  const approvalId = exactText(record["approvalId"]);
  const approvedAt = canonicalInstant(record["approvedAt"]);
  const authenticator = exactSha256(record["authenticator"]);
  const channel = exactText(record["channel"]);
  const contentDigest = exactSha256(record["contentDigest"]);
  const destination = exactText(record["destination"]);
  const effectId = exactText(record["effectId"]);
  const expiresAt = canonicalInstant(record["expiresAt"]);
  const textByteLength = exactNonNegativeInteger(record["textByteLength"]);
  const attachments = parseAttachmentSnapshots(record["attachments"]);
  if (
    !approvalId
    || !approvedAt
    || !authenticator
    || !channel
    || !contentDigest
    || !destination
    || !effectId
    || !expiresAt
    || textByteLength === undefined
    || !attachments
    || Date.parse(approvedAt) >= Date.parse(expiresAt)
  ) {
    return undefined;
  }
  return freezeBinding({
    approvalId,
    approvedAt,
    authenticator,
    attachments,
    channel,
    contentDigest,
    destination,
    effectId,
    expiresAt,
    schemaVersion: COMMUNICATION_CONTENT_APPROVAL_VERSION,
    textByteLength
  });
}

function parseAttachmentSnapshots(
  value: unknown
): CommunicationContentApprovalBinding["attachments"] | undefined {
  const values = exactDataArray(value);
  if (!values || values.length > MAX_ATTACHMENTS) return undefined;
  const output: Array<CommunicationContentApprovalBinding["attachments"][number]> = [];
  const ids = new Set<string>();
  for (const [index, valueAtIndex] of values.entries()) {
    const record = exactDataRecord(valueAtIndex, [
      "attachmentId",
      "byteLength",
      "contentSha256",
      "fileName",
      "mediaType",
      "order"
    ]);
    if (!record) return undefined;
    const attachmentId = exactText(record["attachmentId"]);
    const byteLength = exactNonNegativeInteger(record["byteLength"]);
    const contentSha256 = exactSha256(record["contentSha256"]);
    const fileName = exactText(record["fileName"]);
    const mediaType = exactText(record["mediaType"]);
    if (
      !attachmentId
      || byteLength === undefined
      || !contentSha256
      || !fileName
      || !mediaType
      || record["order"] !== index
      || ids.has(attachmentId)
    ) {
      return undefined;
    }
    ids.add(attachmentId);
    output.push(Object.freeze({
      attachmentId,
      byteLength,
      contentSha256,
      fileName,
      mediaType,
      order: index
    }));
  }
  return Object.freeze(output);
}

function freezeBinding(
  value: CommunicationContentApprovalBinding
): CommunicationContentApprovalBinding {
  return Object.freeze({
    ...value,
    attachments: Object.freeze([...value.attachments])
  });
}

type UnsignedCommunicationContentApprovalBinding =
  Omit<CommunicationContentApprovalBinding, "authenticator">;

function unsignedBinding(
  binding: CommunicationContentApprovalBinding
): UnsignedCommunicationContentApprovalBinding {
  return {
    approvalId: binding.approvalId,
    approvedAt: binding.approvedAt,
    attachments: binding.attachments,
    channel: binding.channel,
    contentDigest: binding.contentDigest,
    destination: binding.destination,
    effectId: binding.effectId,
    expiresAt: binding.expiresAt,
    schemaVersion: binding.schemaVersion,
    textByteLength: binding.textByteLength
  };
}

function authenticateBinding(
  binding: UnsignedCommunicationContentApprovalBinding,
  authorityKey: Uint8Array
): string {
  return createHmac("sha256", authorityKey)
    .update(JSON.stringify(unsignedBindingPayload(binding)), "utf8")
    .digest("hex");
}

function unsignedBindingPayload(
  binding: UnsignedCommunicationContentApprovalBinding
): UnsignedCommunicationContentApprovalBinding {
  return {
    approvalId: binding.approvalId,
    approvedAt: binding.approvedAt,
    attachments: binding.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      byteLength: attachment.byteLength,
      contentSha256: attachment.contentSha256,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      order: attachment.order
    })),
    channel: binding.channel,
    contentDigest: binding.contentDigest,
    destination: binding.destination,
    effectId: binding.effectId,
    expiresAt: binding.expiresAt,
    schemaVersion: binding.schemaVersion,
    textByteLength: binding.textByteLength
  };
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function exactDataRecord(
  value: unknown,
  requiredKeys: readonly string[]
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== requiredKeys.length
    || keys.some((key) => typeof key !== "string" || !requiredKeys.includes(key))
    || requiredKeys.some((key) => !keys.includes(key))
  ) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
}

function exactDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_unused, index) => index.toString());
  if (
    keys.length !== expected.length + 1
    || keys.at(-1) !== "length"
    || expected.some((key, index) => keys[index] !== key)
  ) {
    return undefined;
  }
  const output: unknown[] = [];
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
}

function exactBytes(value: unknown): Uint8Array | undefined {
  if (
    !value
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !(value instanceof Uint8Array)
    || (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))
    || !(value.buffer instanceof ArrayBuffer)
  ) {
    return undefined;
  }
  return Uint8Array.from(value);
}

function exactAuthorityKey(value: unknown): Uint8Array | undefined {
  const bytes = exactBytes(value);
  return bytes && bytes.byteLength >= 32 ? bytes : undefined;
}

function exactText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function exactSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function exactNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function canonicalInstant(value: unknown): string | undefined {
  const text = exactText(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === text
    ? text
    : undefined;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function heldBind(
  reason: Extract<BindCommunicationContentApprovalResult, { status: "held" }>["reason"]
): Extract<BindCommunicationContentApprovalResult, { status: "held" }> {
  return Object.freeze({ reason, status: "held" as const });
}

function heldVerify(
  reason: Extract<VerifyCommunicationContentApprovalResult, { status: "held" }>["reason"]
): Extract<VerifyCommunicationContentApprovalResult, { status: "held" }> {
  return Object.freeze({ canSend: false, reason, status: "held" as const });
}
