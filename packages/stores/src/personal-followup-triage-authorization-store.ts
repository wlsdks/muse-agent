import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock } from "./atomic-file-store.js";
import { withRequiredProcessLock } from "./digest-lock.js";
import {
  previewFollowupTriage,
  type FollowupTriageAction,
  type FollowupTriagePreview,
  type PreviewFollowupTriageOptions
} from "./personal-followup-triage-preview.js";

export interface AuthorizeFollowupTriageOptions extends PreviewFollowupTriageOptions {
  readonly ledgerFile: string;
  readonly failpoint?: (point: "before-ledger" | "after-ledger") => void | Promise<void>;
}

export interface FollowupTriageAuthorization {
  readonly schemaVersion: "muse.followup-triage-authorization/v1";
  readonly operationId: string;
  readonly confirmToken: string;
  readonly expiresAt: string;
  readonly preview: FollowupTriagePreview;
}

export interface FollowupTriagePreviewedEvent {
  readonly type: "previewed";
  readonly eventId: string;
  readonly operationId: string;
  readonly recordedAt: string;
  readonly previousHash: string;
  readonly hash: string;
  readonly action: FollowupTriageAction;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly ids: readonly string[];
  readonly sourceDigest: string;
  readonly previewDigest: string;
  readonly snoozeAt?: string;
  readonly draftDigest?: string;
}

export interface FollowupTriageLedger {
  readonly schemaVersion: "muse.followup-triage-ledger/v1";
  readonly events: readonly FollowupTriagePreviewedEvent[];
}

export class FollowupTriageAuthorizationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowupTriageAuthorizationStoreError";
  }
}

export class FollowupTriageAuthorizationLockError extends Error {
  readonly reason: "held" | "error";

  constructor(reason: "held" | "error", detail?: string) {
    super(reason === "held"
      ? "follow-up triage authorization unavailable: firing lock is held"
      : `follow-up triage authorization unavailable: firing lock failed${detail ? `: ${detail}` : ""}`);
    this.name = "FollowupTriageAuthorizationLockError";
    this.reason = reason;
  }
}

const LEDGER_VERSION = "muse.followup-triage-ledger/v1" as const;
const GENESIS = sha256(LEDGER_VERSION);
const TOKEN_TTL_MS = 15 * 60_000;
const MAX_EVENTS = 10_000;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;

export async function authorizeFollowupTriage(
  options: AuthorizeFollowupTriageOptions
): Promise<FollowupTriageAuthorization> {
  const outcome = await withRequiredProcessLock(`${options.followupsFile}.firing.lock`, () =>
    withFileLock(options.followupsFile, () => withFileLock(options.ledgerFile, async () => {
      const preview = await previewFollowupTriage(options);
      const operationId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.parse(preview.createdAt) + TOKEN_TTL_MS).toISOString();
      let ledger = await readFollowupTriageLedgerStrict(options.ledgerFile);
      const event = createEvent(ledger.events, {
        action: preview.action,
        ...(preview.digestDraft ? { draftDigest: sha256(preview.digestDraft) } : {}),
        expiresAt,
        ids: preview.items.map((item) => item.id),
        operationId,
        previewDigest: sha256(canonicalJson(preview)),
        recordedAt: preview.createdAt,
        ...(preview.action === "snooze"
          ? { snoozeAt: preview.changes[0]!.after.scheduledFor }
          : {}),
        sourceDigest: preview.sourceDigest,
        tokenHash: sha256(secret),
        type: "previewed"
      });
      await options.failpoint?.("before-ledger");
      ledger = await appendEvent(options.ledgerFile, ledger, event);
      void ledger;
      await options.failpoint?.("after-ledger");
      return {
        confirmToken: `ft1_${operationId}_${secret}`,
        expiresAt,
        operationId,
        preview,
        schemaVersion: "muse.followup-triage-authorization/v1" as const
      };
    }))
  );
  if (outcome.kind === "lock-held") throw new FollowupTriageAuthorizationLockError("held");
  if (outcome.kind === "lock-error") throw new FollowupTriageAuthorizationLockError("error", outcome.error);
  return outcome.value;
}

export async function readFollowupTriageLedgerStrict(file: string): Promise<FollowupTriageLedger> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], schemaVersion: LEDGER_VERSION };
    }
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger cannot be read");
  }
  if (Buffer.byteLength(raw) > MAX_LEDGER_BYTES) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger exceeds size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger is corrupt");
  }
  if (!isExactObject(parsed, ["events", "schemaVersion"])
    || parsed.schemaVersion !== LEDGER_VERSION
    || !Array.isArray(parsed.events)
    || parsed.events.length > MAX_EVENTS) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger has an unsupported schema");
  }
  let previousHash = GENESIS;
  const eventIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const value of parsed.events) {
    if (!isPreviewedEvent(value)
      || value.previousHash !== previousHash
      || eventHash(value) !== value.hash
      || Buffer.byteLength(canonicalJson(value)) > MAX_EVENT_BYTES
      || eventIds.has(value.eventId)
      || operationIds.has(value.operationId)) {
      throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger hash chain is invalid");
    }
    eventIds.add(value.eventId);
    operationIds.add(value.operationId);
    previousHash = value.hash;
  }
  return { events: parsed.events as FollowupTriagePreviewedEvent[], schemaVersion: LEDGER_VERSION };
}

function createEvent(
  events: readonly FollowupTriagePreviewedEvent[],
  input: Omit<FollowupTriagePreviewedEvent, "eventId" | "previousHash" | "hash">
): FollowupTriagePreviewedEvent {
  const withoutHash = {
    ...input,
    eventId: randomUUID(),
    previousHash: events.at(-1)?.hash ?? GENESIS
  };
  return { ...withoutHash, hash: sha256(canonicalJson(withoutHash)) };
}

async function appendEvent(
  file: string,
  ledger: FollowupTriageLedger,
  event: FollowupTriagePreviewedEvent
): Promise<FollowupTriageLedger> {
  if (ledger.events.length >= MAX_EVENTS) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger capacity reached");
  }
  if (Buffer.byteLength(canonicalJson(event)) > MAX_EVENT_BYTES) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage event exceeds size limit");
  }
  const next = { events: [...ledger.events, event], schemaVersion: LEDGER_VERSION };
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_LEDGER_BYTES) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger exceeds size limit");
  }
  await atomicWriteFile(file, payload, { mode: 0o600 });
  return next;
}

function isPreviewedEvent(value: unknown): value is FollowupTriagePreviewedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const action = event.action as FollowupTriageAction;
  const optional = [
    ...(action === "snooze" ? ["snoozeAt"] : []),
    ...(action === "draft-digest" ? ["draftDigest"] : [])
  ];
  if (!isExactObject(event, [
    "type", "eventId", "operationId", "recordedAt", "previousHash", "hash",
    "action", "tokenHash", "expiresAt", "ids", "sourceDigest", "previewDigest",
    ...optional
  ])) return false;
  if (event.type !== "previewed"
    || typeof event.eventId !== "string" || !UUID_RE.test(event.eventId)
    || typeof event.operationId !== "string" || !UUID_RE.test(event.operationId)
    || typeof event.recordedAt !== "string" || !isCanonicalIso(event.recordedAt)
    || typeof event.previousHash !== "string" || !HASH_RE.test(event.previousHash)
    || typeof event.hash !== "string" || !HASH_RE.test(event.hash)
    || !["dismiss", "snooze", "retain", "draft-digest"].includes(action)
    || typeof event.tokenHash !== "string" || !HASH_RE.test(event.tokenHash)
    || typeof event.expiresAt !== "string" || !isCanonicalIso(event.expiresAt)
    || Date.parse(event.expiresAt) !== Date.parse(event.recordedAt) + TOKEN_TTL_MS
    || !Array.isArray(event.ids) || event.ids.length < 1 || event.ids.length > 20
    || !event.ids.every((id) => typeof id === "string" && id.length > 0 && id === id.trim())
    || new Set(event.ids).size !== event.ids.length
    || typeof event.sourceDigest !== "string" || !HASH_RE.test(event.sourceDigest)
    || typeof event.previewDigest !== "string" || !HASH_RE.test(event.previewDigest)) {
    return false;
  }
  return (action !== "snooze"
      || (typeof event.snoozeAt === "string"
        && isCanonicalIso(event.snoozeAt)
        && Date.parse(event.snoozeAt) > Date.parse(event.recordedAt)))
    && (action !== "draft-digest"
      || (typeof event.draftDigest === "string" && HASH_RE.test(event.draftDigest)));
}

function isCanonicalIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).sort().join("\0") === [...keys].sort().join("\0");
}

function eventHash(event: FollowupTriagePreviewedEvent): string {
  const { hash: _hash, ...withoutHash } = event;
  return sha256(canonicalJson(withoutHash));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
