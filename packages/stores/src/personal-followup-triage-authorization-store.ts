import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock } from "./atomic-file-store.js";
import { withRequiredProcessLock } from "./digest-lock.js";
import {
  previewFollowupTriage,
  type FollowupTriageAction,
  type FollowupTriagePreview,
  type PreviewFollowupTriageOptions
} from "./personal-followup-triage-preview.js";
import {
  FollowupStoreUnavailableError,
  parseFollowupsStrict,
  type PersistedFollowup
} from "./personal-followups-store.js";

export interface AuthorizeFollowupTriageOptions extends PreviewFollowupTriageOptions {
  readonly ledgerFile: string;
  readonly failpoint?: (point: "before-ledger" | "after-ledger") => void | Promise<void>;
}

export interface ConfirmFollowupTriageOptions {
  readonly followupsFile: string;
  readonly ledgerFile: string;
  readonly token: string;
  readonly now?: () => Date;
  readonly failpoint?: (
    point:
      | "before-prepared"
      | "after-prepared"
      | "before-followups"
      | "after-followups"
      | "before-terminal"
      | "after-terminal"
  ) => void | Promise<void>;
}

export interface FollowupTriageAuthorization {
  readonly schemaVersion: "muse.followup-triage-authorization/v1";
  readonly operationId: string;
  readonly confirmToken: string;
  readonly expiresAt: string;
  readonly preview: FollowupTriagePreview;
}

export type FollowupTriageOutcome =
  | "applied"
  | "recovered-post-image"
  | "snooze-time-elapsed"
  | "snapshot-drift"
  | "indeterminate-after-preparation";

export interface FollowupTriageResult {
  readonly schemaVersion: "muse.followup-triage-result/v1";
  readonly operationId: string;
  readonly action: FollowupTriageAction;
  readonly ids: readonly string[];
  readonly sourceDigest: string;
  readonly postSourceDigest: string | null;
  readonly status: "applied" | "conflict";
  readonly outcome: FollowupTriageOutcome;
  readonly resultDigest: string;
}

interface EventBase {
  readonly type: string;
  readonly eventId: string;
  readonly operationId: string;
  readonly recordedAt: string;
  readonly previousHash: string;
  readonly hash: string;
}

export interface FollowupTriagePreviewedEvent extends EventBase {
  readonly type: "previewed";
  readonly action: FollowupTriageAction;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly ids: readonly string[];
  readonly sourceDigest: string;
  readonly previewDigest: string;
  readonly snoozeAt?: string;
  readonly draftDigest?: string;
}

export interface FollowupTriagePreparedEvent extends EventBase {
  readonly type: "prepared";
  readonly previewEventId: string;
  readonly preparedAt: string;
  readonly preSourceDigest: string;
  readonly postSourceDigest: string;
}

export interface FollowupTriageTerminalEvent extends EventBase {
  readonly type: "terminal";
  readonly previewEventId: string;
  readonly preparedEventId?: string;
  readonly status: "applied" | "conflict";
  readonly outcome: FollowupTriageOutcome;
  readonly result: FollowupTriageResult;
}

export type FollowupTriageLedgerEvent =
  | FollowupTriagePreviewedEvent
  | FollowupTriagePreparedEvent
  | FollowupTriageTerminalEvent;

export interface FollowupTriageLedger {
  readonly schemaVersion: "muse.followup-triage-ledger/v1";
  readonly events: readonly FollowupTriageLedgerEvent[];
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
const TOKEN_RE = /^ft1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
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
      const event = createEvent<FollowupTriagePreviewedEvent>(ledger.events, {
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
  return unwrapLock(outcome);
}

export async function confirmFollowupTriage(
  options: ConfirmFollowupTriageOptions
): Promise<FollowupTriageResult> {
  const token = parseToken(options.token);
  const now = options.now ?? (() => new Date());
  const outcome = await withRequiredProcessLock(`${options.followupsFile}.firing.lock`, () =>
    withFileLock(options.followupsFile, () => withFileLock(options.ledgerFile, async () => {
      let ledger = await readFollowupTriageLedgerStrict(options.ledgerFile);
      const preview = ledger.events.find((event): event is FollowupTriagePreviewedEvent =>
        event.type === "previewed" && event.operationId === token.operationId
      );
      if (!preview || !hashEquals(preview.tokenHash, sha256(token.secret))) {
        throw new FollowupTriageAuthorizationStoreError("invalid follow-up triage token");
      }
      const terminal = ledger.events.find((event): event is FollowupTriageTerminalEvent =>
        event.type === "terminal" && event.operationId === token.operationId
      );
      if (terminal) return terminal.result;

      let prepared = ledger.events.find((event): event is FollowupTriagePreparedEvent =>
        event.type === "prepared" && event.operationId === token.operationId
      );
      const at = now();
      if (!Number.isFinite(at.getTime())) {
        throw new FollowupTriageAuthorizationStoreError("follow-up triage now must be valid");
      }
      let source: SourceSnapshot | undefined;
      let postRaw: string | undefined;
      let justPrepared = false;

      if (!prepared) {
        if (at.getTime() > Date.parse(preview.expiresAt)) {
          throw new FollowupTriageAuthorizationStoreError("follow-up triage token expired");
        }
        if (preview.action === "snooze" && Date.parse(preview.snoozeAt!) <= at.getTime()) {
          return appendTerminal(options, ledger, preview, undefined, "conflict", "snooze-time-elapsed", at);
        }
        source = await readSourceStrict(options.followupsFile);
        if (source.digest !== preview.sourceDigest) {
          return appendTerminal(options, ledger, preview, undefined, "conflict", "snapshot-drift", at);
        }
        postRaw = buildPostRaw(source, preview);
        prepared = createEvent<FollowupTriagePreparedEvent>(ledger.events, {
          operationId: preview.operationId,
          preparedAt: at.toISOString(),
          postSourceDigest: sha256(postRaw),
          preSourceDigest: source.digest,
          previewEventId: preview.eventId,
          recordedAt: at.toISOString(),
          type: "prepared"
        });
        await options.failpoint?.("before-prepared");
        ledger = await appendEvent(options.ledgerFile, ledger, prepared);
        await options.failpoint?.("after-prepared");
        justPrepared = true;
      }

      source ??= await readSourceStrict(options.followupsFile);
      if (justPrepared) {
        postRaw ??= buildPostRaw(source, preview);
        if (prepared.preSourceDigest !== prepared.postSourceDigest) {
          await options.failpoint?.("before-followups");
          await atomicWriteFile(options.followupsFile, postRaw, { mode: 0o600 });
          await options.failpoint?.("after-followups");
        }
        return appendTerminal(options, ledger, preview, prepared, "applied", "applied", at);
      }

      if (source.digest === prepared.postSourceDigest) {
        return appendTerminal(options, ledger, preview, prepared, "applied", "recovered-post-image", at);
      }
      if (source.digest === prepared.preSourceDigest) {
        if (preview.action === "snooze" && Date.parse(preview.snoozeAt!) <= at.getTime()) {
          return appendTerminal(options, ledger, preview, prepared, "conflict", "snooze-time-elapsed", at);
        }
        postRaw = buildPostRaw(source, preview);
        if (sha256(postRaw) !== prepared.postSourceDigest) {
          return appendTerminal(options, ledger, preview, prepared, "conflict", "indeterminate-after-preparation", at);
        }
        if (prepared.preSourceDigest !== prepared.postSourceDigest) {
          await options.failpoint?.("before-followups");
          await atomicWriteFile(options.followupsFile, postRaw, { mode: 0o600 });
          await options.failpoint?.("after-followups");
        }
        return appendTerminal(options, ledger, preview, prepared, "applied", "applied", at);
      }
      return appendTerminal(options, ledger, preview, prepared, "conflict", "indeterminate-after-preparation", at);
    }))
  );
  return unwrapLock(outcome);
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

  const events = parsed.events as unknown[];
  let previousHash = GENESIS;
  const eventIds = new Set<string>();
  const states = new Map<string, {
    preview?: FollowupTriagePreviewedEvent;
    prepared?: FollowupTriagePreparedEvent;
    terminal?: FollowupTriageTerminalEvent;
  }>();
  for (const value of events) {
    if (!isLedgerEvent(value)
      || value.previousHash !== previousHash
      || eventHash(value) !== value.hash
      || Buffer.byteLength(canonicalJson(value)) > MAX_EVENT_BYTES
      || eventIds.has(value.eventId)) {
      throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger hash chain is invalid");
    }
    eventIds.add(value.eventId);
    const state = states.get(value.operationId) ?? {};
    if (value.type === "previewed") {
      if (state.preview || state.prepared || state.terminal) throw invalidState();
      state.preview = value;
    } else if (value.type === "prepared") {
      const preview = state.preview;
      const sourceMustChange = preview?.action === "dismiss" || preview?.action === "snooze";
      if (!preview || state.prepared || state.terminal
        || value.previewEventId !== preview.eventId
        || value.preSourceDigest !== preview.sourceDigest
        || Date.parse(value.preparedAt) < Date.parse(preview.recordedAt)
        || Date.parse(value.preparedAt) > Date.parse(preview.expiresAt)
        || (sourceMustChange
          ? value.postSourceDigest === value.preSourceDigest
          : value.postSourceDigest !== value.preSourceDigest)
        || (preview.action === "snooze"
          && Date.parse(value.preparedAt) >= Date.parse(preview.snoozeAt!))) {
        throw invalidState();
      }
      state.prepared = value;
    } else {
      const preview = state.preview;
      const prepared = state.prepared;
      const expected = preview && (value.status === "conflict" || prepared)
        ? buildResult(preview, prepared, value.status, value.outcome)
        : undefined;
      if (!preview || state.terminal
        || value.previewEventId !== preview.eventId
        || !isValidTerminalTransition(preview, prepared, value)
        || canonicalJson(value.result) !== canonicalJson(expected)) {
        throw invalidState();
      }
      state.terminal = value;
    }
    states.set(value.operationId, state);
    previousHash = value.hash;
  }
  return { events: events as FollowupTriageLedgerEvent[], schemaVersion: LEDGER_VERSION };
}

function isValidTerminalTransition(
  preview: FollowupTriagePreviewedEvent,
  prepared: FollowupTriagePreparedEvent | undefined,
  terminal: FollowupTriageTerminalEvent
): boolean {
  const terminalAt = Date.parse(terminal.recordedAt);
  const expiresAt = Date.parse(preview.expiresAt);
  const snoozeAt = preview.action === "snooze" ? Date.parse(preview.snoozeAt!) : undefined;
  if (terminalAt < Date.parse(prepared?.preparedAt ?? preview.recordedAt)) return false;

  if (terminal.outcome === "applied") {
    return terminal.status === "applied"
      && prepared !== undefined
      && terminal.preparedEventId === prepared.eventId
      && (snoozeAt === undefined || terminalAt < snoozeAt);
  }
  if (terminal.outcome === "recovered-post-image") {
    return terminal.status === "applied"
      && prepared !== undefined
      && terminal.preparedEventId === prepared.eventId;
  }
  if (terminal.outcome === "indeterminate-after-preparation") {
    return terminal.status === "conflict"
      && prepared !== undefined
      && terminal.preparedEventId === prepared.eventId;
  }
  if (terminal.outcome === "snapshot-drift") {
    return terminal.status === "conflict"
      && prepared === undefined
      && terminal.preparedEventId === undefined
      && terminalAt <= expiresAt
      && (snoozeAt === undefined || terminalAt < snoozeAt);
  }
  return terminal.status === "conflict"
    && snoozeAt !== undefined
    && terminalAt >= snoozeAt
    && (prepared
      ? terminal.preparedEventId === prepared.eventId
      : terminal.preparedEventId === undefined && terminalAt <= expiresAt);
}

interface SourceSnapshot {
  readonly raw: string;
  readonly digest: string;
  readonly items: readonly PersistedFollowup[];
}

async function readSourceStrict(file: string): Promise<SourceSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new FollowupStoreUnavailableError();
  }
  return { digest: sha256(raw), items: parseFollowupsStrict(raw), raw };
}

function buildPostRaw(source: SourceSnapshot, preview: FollowupTriagePreviewedEvent): string {
  const ids = new Set(preview.ids);
  const selected = preview.ids.map((id) => source.items.find((item) => item.id === id));
  if (selected.some((item) => !item
    || item.status !== "scheduled"
    || Date.parse(item.scheduledFor) > Date.parse(preview.recordedAt))) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage prepared source is invalid");
  }
  if (preview.action === "retain" || preview.action === "draft-digest") return source.raw;
  let matched = 0;
  const next = source.items.map((item): PersistedFollowup => {
    if (!ids.has(item.id)) return item;
    matched += 1;
    if (item.status !== "scheduled" || Date.parse(item.scheduledFor) > Date.parse(preview.recordedAt)) {
      throw new FollowupTriageAuthorizationStoreError("follow-up triage prepared source is invalid");
    }
    return preview.action === "dismiss"
      ? { ...item, cancelReason: "backlog-triage-dismissed", status: "cancelled" }
      : { ...item, scheduledFor: preview.snoozeAt! };
  });
  if (matched !== preview.ids.length) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage prepared source is invalid");
  }
  return `${JSON.stringify({ followups: next }, null, 2)}\n`;
}

async function appendTerminal(
  options: ConfirmFollowupTriageOptions,
  ledger: FollowupTriageLedger,
  preview: FollowupTriagePreviewedEvent,
  prepared: FollowupTriagePreparedEvent | undefined,
  status: "applied" | "conflict",
  outcome: FollowupTriageOutcome,
  at: Date
): Promise<FollowupTriageResult> {
  const result = buildResult(preview, prepared, status, outcome);
  const event = createEvent<FollowupTriageTerminalEvent>(ledger.events, {
    operationId: preview.operationId,
    outcome,
    ...(prepared ? { preparedEventId: prepared.eventId } : {}),
    previewEventId: preview.eventId,
    recordedAt: at.toISOString(),
    result,
    status,
    type: "terminal"
  });
  await options.failpoint?.("before-terminal");
  await appendEvent(options.ledgerFile, ledger, event);
  await options.failpoint?.("after-terminal");
  return result;
}

function buildResult(
  preview: FollowupTriagePreviewedEvent,
  prepared: FollowupTriagePreparedEvent | undefined,
  status: "applied" | "conflict",
  outcome: FollowupTriageOutcome
): FollowupTriageResult {
  const withoutDigest = {
    action: preview.action,
    ids: preview.ids,
    operationId: preview.operationId,
    outcome,
    postSourceDigest: status === "applied" ? prepared!.postSourceDigest : null,
    schemaVersion: "muse.followup-triage-result/v1" as const,
    sourceDigest: preview.sourceDigest,
    status
  };
  return { ...withoutDigest, resultDigest: sha256(canonicalJson(withoutDigest)) };
}

function createEvent<T extends FollowupTriageLedgerEvent>(
  events: readonly FollowupTriageLedgerEvent[],
  input: Omit<T, "eventId" | "previousHash" | "hash">
): T {
  const withoutHash = {
    ...input,
    eventId: randomUUID(),
    previousHash: events.at(-1)?.hash ?? GENESIS
  };
  return { ...withoutHash, hash: sha256(canonicalJson(withoutHash)) } as T;
}

async function appendEvent(
  file: string,
  ledger: FollowupTriageLedger,
  event: FollowupTriageLedgerEvent
): Promise<FollowupTriageLedger> {
  if (ledger.events.length >= MAX_EVENTS) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger capacity reached");
  }
  if (Buffer.byteLength(canonicalJson(event)) > MAX_EVENT_BYTES) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage event exceeds size limit");
  }
  const next: FollowupTriageLedger = { events: [...ledger.events, event], schemaVersion: LEDGER_VERSION };
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_LEDGER_BYTES) {
    throw new FollowupTriageAuthorizationStoreError("follow-up triage ledger exceeds size limit");
  }
  await atomicWriteFile(file, payload, { mode: 0o600 });
  return next;
}

function isLedgerEvent(value: unknown): value is FollowupTriageLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!isEventBase(event)) return false;
  if (event.type === "previewed") return isPreviewedEvent(event);
  if (event.type === "prepared") {
    return isExactObject(event, [
      "type", "eventId", "operationId", "recordedAt", "previousHash", "hash",
      "previewEventId", "preparedAt", "preSourceDigest", "postSourceDigest"
    ])
      && typeof event.previewEventId === "string" && UUID_RE.test(event.previewEventId)
      && typeof event.preparedAt === "string" && isCanonicalIso(event.preparedAt)
      && event.recordedAt === event.preparedAt
      && typeof event.preSourceDigest === "string" && HASH_RE.test(event.preSourceDigest)
      && typeof event.postSourceDigest === "string" && HASH_RE.test(event.postSourceDigest);
  }
  if (event.type === "terminal") {
    const hasPrepared = event.preparedEventId !== undefined;
    return isExactObject(event, [
      "type", "eventId", "operationId", "recordedAt", "previousHash", "hash",
      "previewEventId", ...(hasPrepared ? ["preparedEventId"] : []),
      "status", "outcome", "result"
    ])
      && typeof event.previewEventId === "string" && UUID_RE.test(event.previewEventId)
      && (!hasPrepared || (typeof event.preparedEventId === "string" && UUID_RE.test(event.preparedEventId)))
      && (event.status === "applied" || event.status === "conflict")
      && isOutcome(event.outcome)
      && isResult(event.result);
  }
  return false;
}

function isEventBase(event: Record<string, unknown>): boolean {
  return typeof event.type === "string"
    && typeof event.eventId === "string" && UUID_RE.test(event.eventId)
    && typeof event.operationId === "string" && UUID_RE.test(event.operationId)
    && typeof event.recordedAt === "string" && isCanonicalIso(event.recordedAt)
    && typeof event.previousHash === "string" && HASH_RE.test(event.previousHash)
    && typeof event.hash === "string" && HASH_RE.test(event.hash);
}

function isPreviewedEvent(event: Record<string, unknown>): boolean {
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
    || !["dismiss", "snooze", "retain", "draft-digest"].includes(action)
    || typeof event.tokenHash !== "string" || !HASH_RE.test(event.tokenHash)
    || typeof event.expiresAt !== "string" || !isCanonicalIso(event.expiresAt)
    || Date.parse(event.expiresAt) !== Date.parse(String(event.recordedAt)) + TOKEN_TTL_MS
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
        && Date.parse(event.snoozeAt) > Date.parse(String(event.recordedAt))))
    && (action !== "draft-digest"
      || (typeof event.draftDigest === "string" && HASH_RE.test(event.draftDigest)));
}

function isResult(value: unknown): value is FollowupTriageResult {
  if (!isExactObject(value, [
    "schemaVersion", "operationId", "action", "ids", "sourceDigest",
    "postSourceDigest", "status", "outcome", "resultDigest"
  ])) return false;
  if (value.schemaVersion !== "muse.followup-triage-result/v1"
    || typeof value.operationId !== "string" || !UUID_RE.test(value.operationId)
    || !["dismiss", "snooze", "retain", "draft-digest"].includes(String(value.action))
    || !Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 20
    || !value.ids.every((id) => typeof id === "string" && id.length > 0 && id === id.trim())
    || new Set(value.ids).size !== value.ids.length
    || typeof value.sourceDigest !== "string" || !HASH_RE.test(value.sourceDigest)
    || !(value.postSourceDigest === null
      || (typeof value.postSourceDigest === "string" && HASH_RE.test(value.postSourceDigest)))
    || (value.status !== "applied" && value.status !== "conflict")
    || !isOutcome(value.outcome)
    || typeof value.resultDigest !== "string" || !HASH_RE.test(value.resultDigest)) {
    return false;
  }
  const { resultDigest, ...withoutDigest } = value;
  return resultDigest === sha256(canonicalJson(withoutDigest));
}

function isOutcome(value: unknown): value is FollowupTriageOutcome {
  return value === "applied"
    || value === "recovered-post-image"
    || value === "snooze-time-elapsed"
    || value === "snapshot-drift"
    || value === "indeterminate-after-preparation";
}

function parseToken(value: string): { readonly operationId: string; readonly secret: string } {
  if (value.length > 96) throw new FollowupTriageAuthorizationStoreError("invalid follow-up triage token");
  const match = TOKEN_RE.exec(value);
  if (!match) throw new FollowupTriageAuthorizationStoreError("invalid follow-up triage token");
  return { operationId: match[1]!, secret: match[2]! };
}

function hashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function unwrapLock<T>(
  outcome: Awaited<ReturnType<typeof withRequiredProcessLock<T>>>
): T {
  if (outcome.kind === "lock-held") throw new FollowupTriageAuthorizationLockError("held");
  if (outcome.kind === "lock-error") throw new FollowupTriageAuthorizationLockError("error", outcome.error);
  return outcome.value;
}

function invalidState(): FollowupTriageAuthorizationStoreError {
  return new FollowupTriageAuthorizationStoreError("follow-up triage ledger event order is invalid");
}

function isCanonicalIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).sort().join("\0") === [...keys].sort().join("\0");
}

function eventHash(event: FollowupTriageLedgerEvent): string {
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
