import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import {
  compareFollowupsByScheduledFor,
  FollowupStoreUnavailableError,
  parseFollowupsStrict,
  type PersistedFollowup
} from "./personal-followups-store.js";

export type FollowupTriageAction = "dismiss" | "snooze" | "retain" | "draft-digest";

export interface FollowupTriagePreviewChange {
  readonly before: PersistedFollowup;
  readonly after: PersistedFollowup;
}

export interface FollowupTriagePreview {
  readonly schemaVersion: "muse.followup-triage-preview/v1";
  readonly action: FollowupTriageAction;
  readonly changes: readonly FollowupTriagePreviewChange[];
  readonly createdAt: string;
  readonly sourceDigest: string;
  readonly items: readonly PersistedFollowup[];
  readonly digestDraft?: string;
}

export interface PreviewFollowupTriageOptions {
  readonly followupsFile: string;
  readonly action: FollowupTriageAction;
  readonly ids: readonly string[];
  readonly snoozeAt?: string;
  readonly now?: () => Date;
}

const MAX_ITEMS = 20;
const MAX_SUMMARY = 2_000;
const MAX_DRAFT_BYTES = 32 * 1024;
const DISMISS_REASON = "backlog-triage-dismissed";
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

export async function previewFollowupTriage(options: PreviewFollowupTriageOptions): Promise<FollowupTriagePreview> {
  validateIds(options.ids);
  const at = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(at.getTime())) throw new Error("follow-up triage now must be valid");

  let raw: string;
  try {
    raw = await fs.readFile(options.followupsFile, "utf8");
  } catch {
    throw new FollowupStoreUnavailableError();
  }
  const current = parseFollowupsStrict(raw);
  const selected = selectItems(current, options.ids, at);
  const snoozeAt = validateAction(options.action, options.snoozeAt, at);
  const changes = selected.map((before) => ({
    after: projectAfter(before, options.action, snoozeAt),
    before
  }));
  const createdAt = at.toISOString();
  const digestDraft = options.action === "draft-digest"
    ? buildFollowupTriageDigest(selected, createdAt)
    : undefined;

  return {
    action: options.action,
    changes,
    createdAt,
    ...(digestDraft ? { digestDraft } : {}),
    items: selected,
    schemaVersion: "muse.followup-triage-preview/v1",
    sourceDigest: createHash("sha256").update(raw, "utf8").digest("hex")
  };
}

export function buildFollowupTriageDigest(items: readonly PersistedFollowup[], createdAt: string): string {
  const lines = [
    `Follow-up backlog draft (${createdAt})`,
    ...items.map((item) => `- [${item.id}] ${item.summary.replace(/[\r\n\t]+/gu, " ").slice(0, MAX_SUMMARY)} — due ${item.scheduledFor}`)
  ];
  const draft = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(draft, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("follow-up triage digest exceeds 32 KiB");
  }
  return draft;
}

function validateIds(ids: readonly string[]): void {
  if (ids.length < 1 || ids.length > MAX_ITEMS) {
    throw new Error("follow-up triage requires 1 to 20 exact ids");
  }
  if (ids.some((id) => id.length === 0 || id !== id.trim())) {
    throw new Error("follow-up triage ids must be non-empty exact ids");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("follow-up triage ids must be unique");
  }
}

function selectItems(
  current: readonly PersistedFollowup[],
  ids: readonly string[],
  at: Date
): readonly PersistedFollowup[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  const selected = ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`follow-up triage requires exact id: ${id}`);
    if (item.status !== "scheduled" || Date.parse(item.scheduledFor) > at.getTime()) {
      throw new Error(`follow-up ${id} is not scheduled and due`);
    }
    if (item.summary.length > MAX_SUMMARY) {
      throw new Error(`follow-up ${id} summary exceeds 2000 characters`);
    }
    return item;
  });
  return [...selected].sort(compareFollowupsByScheduledFor);
}

function validateAction(
  action: FollowupTriageAction,
  snoozeAt: string | undefined,
  at: Date
): string | undefined {
  if (action !== "dismiss" && action !== "snooze" && action !== "retain" && action !== "draft-digest") {
    throw new Error("follow-up triage action must be dismiss, snooze, retain, or draft-digest");
  }
  if (action !== "snooze") {
    if (snoozeAt !== undefined) throw new Error("--snooze-at is only valid for snooze");
    return undefined;
  }
  if (snoozeAt === undefined) throw new Error("--snooze-at is required for snooze");
  const parsed = parseIsoInstant(snoozeAt);
  if (parsed === undefined || parsed <= at.getTime()) {
    throw new Error("--snooze-at must be a future ISO-8601 instant");
  }
  return new Date(parsed).toISOString();
}

function parseIsoInstant(value: string): number | undefined {
  const match = ISO_INSTANT.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  if (offsetHour > 23 || offsetMinute > 59) return undefined;
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const normalized = new Date(local);
  if (normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
    || normalized.getUTCHours() !== hour
    || normalized.getUTCMinutes() !== minute
    || normalized.getUTCSeconds() !== second
    || normalized.getUTCMilliseconds() !== millisecond) {
    return undefined;
  }
  const offset = offsetHour * 60 + offsetMinute;
  return local - (match[9] === "-" ? -offset : offset) * 60_000;
}

function projectAfter(
  before: PersistedFollowup,
  action: FollowupTriageAction,
  snoozeAt: string | undefined
): PersistedFollowup {
  if (action === "dismiss") {
    return { ...before, cancelReason: DISMISS_REASON, status: "cancelled" };
  }
  if (action === "snooze") {
    return { ...before, scheduledFor: snoozeAt! };
  }
  return before;
}
