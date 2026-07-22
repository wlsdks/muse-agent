import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock } from "./atomic-file-store.js";
import { withRequiredProcessLock } from "./digest-lock.js";
import {
  compareRemindersByDueAt,
  readRemindersStrict,
  serializeReminder,
  writeReminders,
  type PersistedReminder
} from "./personal-reminders-store.js";

export type ReminderTriageAction = "dismiss" | "snooze" | "retain" | "draft-digest";
export type ReminderTriageOutcome = "applied" | "recovered-post-image" | "snooze-time-elapsed" | "snapshot-drift" | "indeterminate-after-preparation";

export interface ReminderTriageItemResult {
  readonly reminderId: string;
  readonly action: ReminderTriageAction;
  readonly beforeDigest: string;
  readonly afterDigest: string | null;
  readonly outcome: "applied" | "recovered-post-image" | "not-applied" | "indeterminate";
}

export interface ReminderTriageResult {
  readonly schemaVersion: "muse.reminder-triage-result/v1";
  readonly operationId: string;
  readonly status: "applied" | "conflict";
  readonly outcome: ReminderTriageOutcome;
  readonly action: ReminderTriageAction;
  readonly items: readonly ReminderTriageItemResult[];
  readonly digestDraft?: string;
}

export interface ReminderTriagePreview {
  readonly schemaVersion: "muse.reminder-triage-preview/v1";
  readonly operationId: string;
  readonly action: ReminderTriageAction;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly items: readonly PersistedReminder[];
  readonly digestDraft?: string;
  readonly confirmToken: string;
}

export class ReminderTriageStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderTriageStoreError";
  }
}

export class ReminderTriageLockError extends Error {
  readonly reason: "held" | "error";
  constructor(reason: "held" | "error", detail?: string) {
    super(reason === "held" ? "reminder triage temporarily unavailable: firing lock is held" : `reminder triage temporarily unavailable: firing lock failed${detail ? `: ${detail}` : ""}`);
    this.name = "ReminderTriageLockError";
    this.reason = reason;
  }
}

type Snapshot = PersistedReminder;
interface EventBase { readonly type: string; readonly eventId: string; readonly operationId: string; readonly recordedAt: string; readonly previousHash: string; readonly hash: string }
interface PreviewedEvent extends EventBase {
  readonly type: "previewed";
  readonly action: ReminderTriageAction;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly snoozeAt?: string;
  readonly items: readonly Snapshot[];
  readonly preStoreDigest: string;
  readonly postStoreDigest: string;
  readonly digestDraft?: string;
}
interface PreparedEvent extends EventBase {
  readonly type: "prepared";
  readonly previewEventId: string;
  readonly preparedAt: string;
  readonly preStoreDigest: string;
  readonly postStoreDigest: string;
}
interface TerminalEvent extends EventBase {
  readonly type: "terminal";
  readonly previewEventId: string;
  readonly preparedEventId?: string;
  readonly status: "applied" | "conflict";
  readonly outcome: ReminderTriageOutcome;
  readonly result: ReminderTriageResult;
}
type LedgerEvent = PreviewedEvent | PreparedEvent | TerminalEvent;
interface Ledger { readonly schemaVersion: "muse.reminder-triage-ledger/v1"; readonly events: readonly LedgerEvent[] }

const LEDGER_VERSION = "muse.reminder-triage-ledger/v1" as const;
const GENESIS = sha256(LEDGER_VERSION);
const TOKEN_TTL_MS = 15 * 60_000;
const MAX_ITEMS = 20;
const MAX_TEXT = 2_000;
const MAX_DRAFT_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const TOKEN_RE = /^rt1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;

export interface PreviewReminderTriageOptions {
  readonly remindersFile: string;
  readonly ledgerFile: string;
  readonly action: ReminderTriageAction;
  readonly ids: readonly string[];
  readonly snoozeAt?: string;
  readonly now?: () => Date;
  readonly failpoint?: (point: "before-preview" | "after-preview") => void | Promise<void>;
}

export interface ConfirmReminderTriageOptions {
  readonly remindersFile: string;
  readonly ledgerFile: string;
  readonly token: string;
  readonly now?: () => Date;
  readonly failpoint?: (point: "before-prepared" | "after-prepared" | "before-reminders" | "after-reminders" | "before-terminal" | "after-terminal") => void | Promise<void>;
}

export async function previewReminderTriage(options: PreviewReminderTriageOptions): Promise<ReminderTriagePreview> {
  validateIds(options.ids);
  const now = options.now ?? (() => new Date());
  const outcome = await withRequiredProcessLock(`${options.remindersFile}.firing.lock`, () =>
    withFileLock(options.remindersFile, () => withFileLock(options.ledgerFile, async () => {
      const at = now();
      const current = await readRemindersStrict(options.remindersFile);
      const selected = selectItems(current, options.ids, at);
      validateAction(selected, options.action, options.snoozeAt, at);
      const operationId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const tokenHash = sha256(secret);
      const createdAt = at.toISOString();
      const expiresAt = new Date(at.getTime() + TOKEN_TTL_MS).toISOString();
      const digestDraft = options.action === "draft-digest" ? buildReminderTriageDigest(selected, createdAt) : undefined;
      const post = applyAction(current, selected, options.action, options.snoozeAt);
      let ledger = await readReminderTriageLedgerStrict(options.ledgerFile);
      const preview = createEvent<PreviewedEvent>(ledger.events, {
        action: options.action,
        ...(digestDraft ? { digestDraft } : {}),
        expiresAt,
        items: selected,
        operationId,
        preStoreDigest: storeDigest(current),
        postStoreDigest: storeDigest(post),
        recordedAt: createdAt,
        ...(options.snoozeAt ? { snoozeAt: canonicalIso(options.snoozeAt, "--snooze-at") } : {}),
        tokenHash,
        type: "previewed"
      } satisfies Omit<PreviewedEvent, "eventId" | "previousHash" | "hash">);
      await options.failpoint?.("before-preview");
      ledger = await appendEvent(options.ledgerFile, ledger, preview);
      void ledger;
      await options.failpoint?.("after-preview");
      return {
        action: options.action,
        confirmToken: `rt1_${operationId}_${secret}`,
        createdAt,
        ...(digestDraft ? { digestDraft } : {}),
        expiresAt,
        items: selected,
        operationId,
        schemaVersion: "muse.reminder-triage-preview/v1" as const
      };
    }))
  );
  return unwrapLock<ReminderTriagePreview>(outcome);
}

export async function confirmReminderTriage(options: ConfirmReminderTriageOptions): Promise<ReminderTriageResult> {
  const token = parseToken(options.token);
  const now = options.now ?? (() => new Date());
  const outcome = await withRequiredProcessLock(`${options.remindersFile}.firing.lock`, () =>
    withFileLock(options.remindersFile, () => withFileLock(options.ledgerFile, async () => {
      let ledger = await readReminderTriageLedgerStrict(options.ledgerFile);
      const preview = ledger.events.find((event): event is PreviewedEvent => event.type === "previewed" && event.operationId === token.operationId);
      if (!preview || preview.tokenHash !== sha256(token.secret)) throw new ReminderTriageStoreError("invalid reminder triage token");
      const terminal = ledger.events.find((event): event is TerminalEvent => event.type === "terminal" && event.operationId === token.operationId);
      if (terminal) return terminal.result;

      let prepared = ledger.events.find((event): event is PreparedEvent => event.type === "prepared" && event.operationId === token.operationId);
      const at = now();
      if (!prepared) {
        if (at.getTime() > Date.parse(preview.expiresAt)) throw new ReminderTriageStoreError("reminder triage token expired");
        const current = await readRemindersStrict(options.remindersFile);
        if (preview.action === "snooze" && Date.parse(preview.snoozeAt!) <= at.getTime()) {
          return appendConflict(options.ledgerFile, ledger, preview, undefined, "snooze-time-elapsed", at.toISOString());
        }
        if (storeDigest(current) !== preview.preStoreDigest) {
          return appendConflict(options.ledgerFile, ledger, preview, undefined, "snapshot-drift", at.toISOString());
        }
        prepared = createEvent<PreparedEvent>(ledger.events, {
          operationId: preview.operationId,
          preStoreDigest: preview.preStoreDigest,
          postStoreDigest: preview.postStoreDigest,
          preparedAt: at.toISOString(),
          previewEventId: preview.eventId,
          recordedAt: at.toISOString(),
          type: "prepared"
        } satisfies Omit<PreparedEvent, "eventId" | "previousHash" | "hash">);
        await options.failpoint?.("before-prepared");
        ledger = await appendEvent(options.ledgerFile, ledger, prepared);
        await options.failpoint?.("after-prepared");
      }

      const current = await readRemindersStrict(options.remindersFile);
      const currentDigest = storeDigest(current);
      let terminalOutcome: ReminderTriageOutcome;
      if (preview.preStoreDigest === preview.postStoreDigest) {
        terminalOutcome = "applied";
      } else if (currentDigest === preview.preStoreDigest) {
        await options.failpoint?.("before-reminders");
        await writeReminders(options.remindersFile, applyAction(current, preview.items, preview.action, preview.snoozeAt));
        await options.failpoint?.("after-reminders");
        terminalOutcome = "applied";
      } else if (currentDigest === preview.postStoreDigest) {
        terminalOutcome = "recovered-post-image";
      } else {
        return appendConflict(options.ledgerFile, ledger, preview, prepared, "indeterminate-after-preparation", now().toISOString());
      }
      const result = buildResult(preview, "applied", terminalOutcome);
      const applied = createEvent<TerminalEvent>(ledger.events, {
        operationId: preview.operationId,
        outcome: terminalOutcome,
        preparedEventId: prepared.eventId,
        previewEventId: preview.eventId,
        recordedAt: now().toISOString(),
        result,
        status: "applied",
        type: "terminal"
      } satisfies Omit<TerminalEvent, "eventId" | "previousHash" | "hash">);
      await options.failpoint?.("before-terminal");
      await appendEvent(options.ledgerFile, ledger, applied);
      await options.failpoint?.("after-terminal");
      return result;
    }))
  );
  return unwrapLock<ReminderTriageResult>(outcome);
}

export async function readReminderTriageLedgerStrict(file: string): Promise<Ledger> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { events: [], schemaVersion: LEDGER_VERSION };
    throw new ReminderTriageStoreError("reminder triage ledger cannot be read");
  }
  if (Buffer.byteLength(raw) > MAX_LEDGER_BYTES) throw new ReminderTriageStoreError("reminder triage ledger exceeds size limit");
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new ReminderTriageStoreError("reminder triage ledger is corrupt"); }
  if (!isExactObject(value, ["events", "schemaVersion"]) || value.schemaVersion !== LEDGER_VERSION || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
    throw new ReminderTriageStoreError("reminder triage ledger has an unsupported schema");
  }
  const events = value.events as unknown[];
  let previousHash = GENESIS;
  const operations = new Map<string, { preview: number; prepared: number; terminal: number }>();
  const previews = new Map<string, PreviewedEvent>();
  const preparedEvents = new Map<string, PreparedEvent>();
  for (const rawEvent of events) {
    if (!isLedgerEvent(rawEvent) || rawEvent.previousHash !== previousHash || eventHash(rawEvent) !== rawEvent.hash || Buffer.byteLength(canonicalJson(rawEvent)) > MAX_EVENT_BYTES) {
      throw new ReminderTriageStoreError("reminder triage ledger hash chain is invalid");
    }
    const counts = operations.get(rawEvent.operationId) ?? { prepared: 0, preview: 0, terminal: 0 };
    counts[rawEvent.type === "previewed" ? "preview" : rawEvent.type === "prepared" ? "prepared" : "terminal"] += 1;
    if (counts.preview > 1 || counts.prepared > 1 || counts.terminal > 1) throw new ReminderTriageStoreError("reminder triage ledger contains duplicate operation events");
    if (rawEvent.type === "previewed") {
      if (counts.prepared > 0 || counts.terminal > 0) throw new ReminderTriageStoreError("reminder triage ledger event order is invalid");
      previews.set(rawEvent.operationId, rawEvent);
    } else if (rawEvent.type === "prepared") {
      const preview = previews.get(rawEvent.operationId);
      if (!preview || rawEvent.previewEventId !== preview.eventId || rawEvent.preStoreDigest !== preview.preStoreDigest || rawEvent.postStoreDigest !== preview.postStoreDigest
        || Date.parse(rawEvent.preparedAt) > Date.parse(preview.expiresAt) || counts.terminal > 0) {
        throw new ReminderTriageStoreError("reminder triage prepared event is invalid");
      }
      preparedEvents.set(rawEvent.operationId, rawEvent);
    } else {
      const preview = previews.get(rawEvent.operationId);
      const prepared = preparedEvents.get(rawEvent.operationId);
      const needsPrepared = rawEvent.outcome === "applied" || rawEvent.outcome === "recovered-post-image" || rawEvent.outcome === "indeterminate-after-preparation";
      const statusMatchesOutcome = rawEvent.status === "applied"
        ? rawEvent.outcome === "applied" || rawEvent.outcome === "recovered-post-image"
        : rawEvent.outcome === "snooze-time-elapsed" || rawEvent.outcome === "snapshot-drift" || rawEvent.outcome === "indeterminate-after-preparation";
      const expectedResult = preview ? buildResult(preview, rawEvent.status, rawEvent.outcome) : undefined;
      if (!preview || rawEvent.previewEventId !== preview.eventId || rawEvent.result.operationId !== rawEvent.operationId
        || rawEvent.result.action !== preview.action || rawEvent.result.status !== rawEvent.status || rawEvent.result.outcome !== rawEvent.outcome
        || !statusMatchesOutcome || canonicalJson(rawEvent.result) !== canonicalJson(expectedResult)
        || (needsPrepared ? !prepared || rawEvent.preparedEventId !== prepared.eventId : rawEvent.preparedEventId !== undefined)) {
        throw new ReminderTriageStoreError("reminder triage terminal event is invalid");
      }
    }
    operations.set(rawEvent.operationId, counts);
    previousHash = rawEvent.hash;
  }
  return { events: events as LedgerEvent[], schemaVersion: LEDGER_VERSION };
}

export function buildReminderTriageDigest(items: readonly PersistedReminder[], generatedAt: string): string {
  let output = `# Reminder backlog digest\n\nGenerated: ${generatedAt}\n\n`;
  for (const item of items) {
    const text = item.text.replace(/[\r\n\t]/gu, " ");
    if (text.length > MAX_TEXT) throw new ReminderTriageStoreError("reminder text exceeds digest limit");
    output += `- [ ] ${text} — due ${new Date(item.dueAt).toISOString()} (id: ${item.id})\n`;
  }
  if (Buffer.byteLength(output) > MAX_DRAFT_BYTES) throw new ReminderTriageStoreError("reminder digest exceeds size limit");
  return output;
}

function validateIds(ids: readonly string[]): void {
  if (ids.length < 1 || ids.length > MAX_ITEMS) throw new ReminderTriageStoreError("reminder triage requires 1 to 20 exact ids");
  if (ids.some((id) => id.trim() !== id || id.length === 0) || new Set(ids).size !== ids.length) throw new ReminderTriageStoreError("reminder triage ids must be unique exact ids");
}

function selectItems(current: readonly PersistedReminder[], ids: readonly string[], now: Date): readonly PersistedReminder[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  const selected = ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new ReminderTriageStoreError(`reminder not found by exact id: ${id}`);
    if (item.status !== "pending" || Date.parse(item.dueAt) > now.getTime()) throw new ReminderTriageStoreError(`reminder is not pending and due: ${id}`);
    return item;
  });
  return selected.sort(compareRemindersByDueAt);
}

function validateAction(items: readonly PersistedReminder[], action: ReminderTriageAction, snoozeAt: string | undefined, now: Date): void {
  if (items.length > 1 && (action === "dismiss" || action === "snooze") && items.some((item) => item.recurrence || item.eventId)) {
    throw new ReminderTriageStoreError("recurring or event-linked reminders require single-item dismiss/snooze");
  }
  if (action === "snooze") {
    if (!snoozeAt || Date.parse(canonicalIso(snoozeAt, "--snooze-at")) <= now.getTime()) throw new ReminderTriageStoreError("--snooze-at must be a future ISO-8601 instant");
  } else if (snoozeAt !== undefined) {
    throw new ReminderTriageStoreError("--snooze-at is only valid for snooze");
  }
}

function applyAction(current: readonly PersistedReminder[], selected: readonly PersistedReminder[], action: ReminderTriageAction, snoozeAt?: string): readonly PersistedReminder[] {
  if (action === "retain" || action === "draft-digest") return current;
  const ids = new Set(selected.map((item) => item.id));
  if (action === "dismiss") return current.filter((item) => !ids.has(item.id));
  const dueAt = canonicalIso(snoozeAt!, "--snooze-at");
  return current.map((item) => {
    if (!ids.has(item.id)) return item;
    const { firedAt: _firedAt, ...rest } = item;
    return { ...rest, dueAt, status: "pending" as const };
  });
}

function buildResult(preview: PreviewedEvent, status: "applied" | "conflict", outcome: ReminderTriageOutcome): ReminderTriageResult {
  const itemOutcome = status === "conflict" ? (outcome === "indeterminate-after-preparation" ? "indeterminate" : "not-applied") : (outcome === "recovered-post-image" ? "recovered-post-image" : "applied");
  return {
    action: preview.action,
    ...(preview.digestDraft ? { digestDraft: preview.digestDraft } : {}),
    items: preview.items.map((item) => {
      const { firedAt: _firedAt, ...pending } = item;
      return {
      action: preview.action,
      afterDigest: preview.action === "dismiss" ? null : sha256(canonicalJson(preview.action === "snooze" ? { ...pending, dueAt: preview.snoozeAt!, status: "pending" } : item)),
      beforeDigest: sha256(canonicalJson(item)),
      outcome: itemOutcome,
      reminderId: item.id
    }; }),
    operationId: preview.operationId,
    outcome,
    schemaVersion: "muse.reminder-triage-result/v1",
    status
  };
}

async function appendConflict(file: string, ledger: Ledger, preview: PreviewedEvent, prepared: PreparedEvent | undefined, outcome: Extract<ReminderTriageOutcome, "snooze-time-elapsed" | "snapshot-drift" | "indeterminate-after-preparation">, recordedAt: string): Promise<ReminderTriageResult> {
  const result = buildResult(preview, "conflict", outcome);
  const terminal = createEvent<TerminalEvent>(ledger.events, {
    operationId: preview.operationId,
    outcome,
    ...(prepared ? { preparedEventId: prepared.eventId } : {}),
    previewEventId: preview.eventId,
    recordedAt,
    result,
    status: "conflict",
    type: "terminal"
  } satisfies Omit<TerminalEvent, "eventId" | "previousHash" | "hash">);
  await appendEvent(file, ledger, terminal);
  return result;
}

function createEvent<T extends LedgerEvent>(events: readonly LedgerEvent[], input: Omit<T, "eventId" | "previousHash" | "hash">): T {
  const withoutHash = { ...input, eventId: randomUUID(), previousHash: events.at(-1)?.hash ?? GENESIS };
  return { ...withoutHash, hash: sha256(canonicalJson(withoutHash)) } as T;
}

async function appendEvent(file: string, ledger: Ledger, event: LedgerEvent): Promise<Ledger> {
  if (ledger.events.length >= MAX_EVENTS) throw new ReminderTriageStoreError("reminder triage ledger capacity reached");
  const eventBytes = Buffer.byteLength(canonicalJson(event));
  if (eventBytes > MAX_EVENT_BYTES) throw new ReminderTriageStoreError("reminder triage event exceeds size limit");
  const next: Ledger = { events: [...ledger.events, event], schemaVersion: LEDGER_VERSION };
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_LEDGER_BYTES) throw new ReminderTriageStoreError("reminder triage ledger exceeds size limit");
  await atomicWriteFile(file, payload, { mode: 0o600 });
  return next;
}

function parseToken(value: string): { readonly operationId: string; readonly secret: string } {
  if (value.length > 96) throw new ReminderTriageStoreError("invalid reminder triage token");
  const match = TOKEN_RE.exec(value);
  if (!match) throw new ReminderTriageStoreError("invalid reminder triage token");
  return { operationId: match[1]!, secret: match[2]! };
}

function unwrapLock<T>(outcome: Awaited<ReturnType<typeof withRequiredProcessLock<T>>>): T {
  if (outcome.kind === "lock-held") throw new ReminderTriageLockError("held");
  if (outcome.kind === "lock-error") throw new ReminderTriageLockError("error", outcome.error);
  return outcome.value;
}

function canonicalIso(value: string, label: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ReminderTriageStoreError(`${label} must be an ISO-8601 instant`);
  return new Date(ms).toISOString();
}

function storeDigest(reminders: readonly PersistedReminder[]): string {
  return sha256(canonicalJson(reminders.map((item) => serializeReminder(item))));
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function eventHash(event: LedgerEvent): string {
  const { hash: _hash, ...withoutHash } = event;
  return sha256(canonicalJson(withoutHash));
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).sort().join("\0") === [...keys].sort().join("\0");
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const base = typeof v.type === "string" && typeof v.eventId === "string" && UUID_RE.test(v.eventId)
    && typeof v.operationId === "string" && UUID_RE.test(v.operationId)
    && typeof v.recordedAt === "string" && isCanonicalIso(v.recordedAt)
    && typeof v.previousHash === "string" && HASH_RE.test(v.previousHash)
    && typeof v.hash === "string" && HASH_RE.test(v.hash);
  if (!base) return false;
  if (v.type === "previewed") {
    const action = v.action as ReminderTriageAction;
    const optional = [...(action === "snooze" ? ["snoozeAt"] : []), ...(action === "draft-digest" ? ["digestDraft"] : [])];
    if (!isExactObject(v, ["type", "eventId", "operationId", "recordedAt", "previousHash", "hash", "action", "tokenHash", "expiresAt", "items", "preStoreDigest", "postStoreDigest", ...optional])) return false;
    if (!["dismiss", "snooze", "retain", "draft-digest"].includes(action)
      || typeof v.tokenHash !== "string" || !HASH_RE.test(v.tokenHash)
      || typeof v.expiresAt !== "string" || !isCanonicalIso(v.expiresAt) || Date.parse(v.expiresAt) !== Date.parse(String(v.recordedAt)) + TOKEN_TTL_MS
      || !Array.isArray(v.items) || v.items.length < 1 || v.items.length > MAX_ITEMS || !v.items.every(isSnapshot)
      || typeof v.preStoreDigest !== "string" || !HASH_RE.test(v.preStoreDigest)
      || typeof v.postStoreDigest !== "string" || !HASH_RE.test(v.postStoreDigest)) return false;
    const items = v.items as unknown[];
    const canonicalOrder = items.every((item, index) => index === 0 || compareRemindersByDueAt(items[index - 1] as PersistedReminder, item as PersistedReminder) <= 0);
    const uniqueIds = new Set(items.map((item) => (item as PersistedReminder).id)).size === items.length;
    const dueAtRecorded = Date.parse(String(v.recordedAt));
    let exactDraft = action !== "draft-digest";
    if (action === "draft-digest") {
      try { exactDraft = v.digestDraft === buildReminderTriageDigest(items as PersistedReminder[], String(v.recordedAt)); }
      catch { return false; }
    }
    return items.every((item) => (item as PersistedReminder).status === "pending" && Date.parse((item as PersistedReminder).dueAt) <= dueAtRecorded)
      && canonicalOrder && uniqueIds && exactDraft
      && (!(action === "dismiss" || action === "snooze") || items.length === 1 || items.every((item) => !(item as PersistedReminder).recurrence && !(item as PersistedReminder).eventId))
      && (action !== "snooze" || (typeof v.snoozeAt === "string" && isCanonicalIso(v.snoozeAt) && Date.parse(v.snoozeAt) > dueAtRecorded))
      && (action !== "draft-digest" || (typeof v.digestDraft === "string" && Buffer.byteLength(v.digestDraft) <= MAX_DRAFT_BYTES));
  }
  if (v.type === "prepared") {
    return isExactObject(v, ["type", "eventId", "operationId", "recordedAt", "previousHash", "hash", "previewEventId", "preparedAt", "preStoreDigest", "postStoreDigest"])
      && typeof v.previewEventId === "string" && UUID_RE.test(v.previewEventId) && typeof v.preparedAt === "string" && isCanonicalIso(v.preparedAt) && v.recordedAt === v.preparedAt
      && typeof v.preStoreDigest === "string" && HASH_RE.test(v.preStoreDigest) && typeof v.postStoreDigest === "string" && HASH_RE.test(v.postStoreDigest);
  }
  if (v.type === "terminal") {
    const hasPrepared = v.preparedEventId !== undefined;
    return isExactObject(v, ["type", "eventId", "operationId", "recordedAt", "previousHash", "hash", "previewEventId", ...(hasPrepared ? ["preparedEventId"] : []), "status", "outcome", "result"])
      && typeof v.previewEventId === "string" && UUID_RE.test(v.previewEventId) && (!hasPrepared || (typeof v.preparedEventId === "string" && UUID_RE.test(v.preparedEventId)))
      && (v.status === "applied" || v.status === "conflict") && ["applied", "recovered-post-image", "snooze-time-elapsed", "snapshot-drift", "indeterminate-after-preparation"].includes(String(v.outcome))
      && isResult(v.result);
  }
  return false;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const allowed = ["id", "text", "dueAt", "createdAt", "status", "recurrence", "via", "eventId", "firedAt"];
  if (Object.keys(v).some((key) => !allowed.includes(key))) return false;
  const recurrence = v.recurrence === undefined || ["daily", "weekly", "monthly", "yearly"].includes(String(v.recurrence));
  const via = v.via === undefined || (isExactObject(v.via, ["providerId", "destination"])
    && typeof v.via.providerId === "string" && v.via.providerId.length > 0 && typeof v.via.destination === "string" && v.via.destination.length > 0);
  return typeof v.id === "string" && v.id.length > 0 && typeof v.text === "string" && v.text.length <= MAX_TEXT
    && typeof v.dueAt === "string" && isCanonicalIso(v.dueAt)
    && typeof v.createdAt === "string" && isCanonicalIso(v.createdAt) && (v.status === "pending" || v.status === "fired") && recurrence && via
    && (v.eventId === undefined || typeof v.eventId === "string") && (v.firedAt === undefined || (typeof v.firedAt === "string" && isCanonicalIso(v.firedAt)));
}

function isResult(value: unknown): value is ReminderTriageResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const hasDraft = v.digestDraft !== undefined;
  return isExactObject(v, ["schemaVersion", "operationId", "status", "outcome", "action", "items", ...(hasDraft ? ["digestDraft"] : [])])
    && v.schemaVersion === "muse.reminder-triage-result/v1" && typeof v.operationId === "string" && UUID_RE.test(v.operationId)
    && (v.status === "applied" || v.status === "conflict") && ["applied", "recovered-post-image", "snooze-time-elapsed", "snapshot-drift", "indeterminate-after-preparation"].includes(String(v.outcome))
    && ["dismiss", "snooze", "retain", "draft-digest"].includes(String(v.action))
    && Array.isArray(v.items) && v.items.length >= 1 && v.items.length <= MAX_ITEMS && v.items.every(isItemResult)
    && (v.action === "draft-digest" ? typeof v.digestDraft === "string" && Buffer.byteLength(v.digestDraft) <= MAX_DRAFT_BYTES : v.digestDraft === undefined);
}

function isItemResult(value: unknown): boolean {
  if (!isExactObject(value, ["reminderId", "action", "beforeDigest", "afterDigest", "outcome"])) return false;
  return typeof value.reminderId === "string" && ["dismiss", "snooze", "retain", "draft-digest"].includes(String(value.action))
    && typeof value.beforeDigest === "string" && HASH_RE.test(value.beforeDigest)
    && (value.afterDigest === null || (typeof value.afterDigest === "string" && HASH_RE.test(value.afterDigest)))
    && ["applied", "recovered-post-image", "not-applied", "indeterminate"].includes(String(value.outcome));
}

function isCanonicalIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
