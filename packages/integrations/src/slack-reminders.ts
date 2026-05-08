/**
 * Slack reminder primitives extracted from packages/integrations/src/index.ts.
 * Owns the time parser, the reminder data model, the in-memory store with
 * per-user limits + due collection, the polling daemon, and the
 * `/muse remind` slash-command handler. Re-exported from the integrations
 * barrel for backwards compatibility.
 */

import type { SlackMessageTransport } from "./index.js";

export interface SlackReminder {
  readonly id: number;
  readonly text: string;
  readonly dueAt?: Date;
  readonly createdAt: Date;
}

export interface SlackReminderTimeParseResult {
  readonly cleanText: string;
  readonly dueAt?: Date;
}

const REMINDER_AT_TIME_PATTERN = /(?:^|\s)at\s+(\d{1,2}):(\d{2})(?:\s*$)/iu;
const REMINDER_KOREAN_TIME_PATTERN = /(?:^|\s)(\d{1,2})시(?:\s*(\d{1,2})분)?(?:\s*에?)(?:\s*$)/u;

export interface ReminderTimeParseOptions {
  readonly timezone?: string;
  readonly now?: () => Date;
}

export function parseReminderTime(
  text: string,
  options: ReminderTimeParseOptions = {}
): SlackReminderTimeParseResult {
  const timezone = options.timezone ?? "Asia/Seoul";
  const now = options.now ? options.now() : new Date();

  const atMatch = REMINDER_AT_TIME_PATTERN.exec(text);
  if (atMatch && atMatch[1] && atMatch[2]) {
    const hour = Number.parseInt(atMatch[1], 10);
    const minute = Number.parseInt(atMatch[2], 10);
    const dueAt = resolveReminderInstant(hour, minute, timezone, now);
    if (dueAt) {
      const cleanText = removeRange(text, atMatch.index, atMatch.index + atMatch[0].length).trim();
      return { cleanText: cleanText.length > 0 ? cleanText : text.trim(), dueAt };
    }
  }

  const koreanMatch = REMINDER_KOREAN_TIME_PATTERN.exec(text);
  if (koreanMatch && koreanMatch[1]) {
    const hour = Number.parseInt(koreanMatch[1], 10);
    const minute = koreanMatch[2] ? Number.parseInt(koreanMatch[2], 10) : 0;
    const dueAt = resolveReminderInstant(hour, minute, timezone, now);
    if (dueAt) {
      const cleanText = removeRange(text, koreanMatch.index, koreanMatch.index + koreanMatch[0].length).trim();
      return { cleanText: cleanText.length > 0 ? cleanText : text.trim(), dueAt };
    }
  }

  return { cleanText: text };
}

function resolveReminderInstant(
  hour: number,
  minute: number,
  timezone: string,
  now: Date
): Date | undefined {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  const tzOffsetMinutes = computeTimezoneOffsetMinutes(now, timezone);
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const localTarget = new Date(Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    hour,
    minute,
    0,
    0
  ));
  let utcTarget = new Date(localTarget.getTime() - tzOffsetMinutes * 60_000);
  if (utcTarget.getTime() <= now.getTime()) {
    utcTarget = new Date(utcTarget.getTime() + 24 * 60 * 60 * 1000);
  }
  return utcTarget;
}

function computeTimezoneOffsetMinutes(at: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric"
    });
    const parts = formatter.formatToParts(at);
    const get = (type: string) => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function removeRange(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${text.slice(end)}`;
}

export interface ReminderStore {
  add(userId: string, text: string): SlackReminder;
  list(userId: string): readonly SlackReminder[];
  done(userId: string, id: number): SlackReminder | undefined;
  clear(userId: string): number;
  collectDue(now?: Date): readonly { readonly userId: string; readonly reminder: SlackReminder }[];
}

export interface InMemoryReminderStoreOptions {
  readonly maxPerUser?: number;
  readonly timezone?: string;
  readonly now?: () => Date;
}

export class InMemoryReminderStore implements ReminderStore {
  readonly #maxPerUser: number;
  readonly #timezone: string;
  readonly #now: () => Date;
  readonly #remindersByUser = new Map<string, SlackReminder[]>();
  readonly #sequenceByUser = new Map<string, number>();

  constructor(options: InMemoryReminderStoreOptions = {}) {
    this.#maxPerUser = Math.max(1, options.maxPerUser ?? 50);
    this.#timezone = options.timezone ?? "Asia/Seoul";
    this.#now = options.now ?? (() => new Date());
  }

  add(userId: string, text: string): SlackReminder {
    const parsed = parseReminderTime(text.trim(), { now: this.#now, timezone: this.#timezone });
    const id = (this.#sequenceByUser.get(userId) ?? 0) + 1;
    this.#sequenceByUser.set(userId, id);
    const reminder: SlackReminder = {
      createdAt: this.#now(),
      ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}),
      id,
      text: parsed.cleanText
    };
    const list = this.#remindersByUser.get(userId) ?? [];
    list.push(reminder);
    while (list.length > this.#maxPerUser) {
      list.shift();
    }
    this.#remindersByUser.set(userId, list);
    return reminder;
  }

  list(userId: string): readonly SlackReminder[] {
    return [...(this.#remindersByUser.get(userId) ?? [])].sort((a, b) => a.id - b.id);
  }

  done(userId: string, id: number): SlackReminder | undefined {
    const list = this.#remindersByUser.get(userId);
    if (!list) {
      return undefined;
    }
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = list.splice(index, 1);
    return removed;
  }

  clear(userId: string): number {
    const list = this.#remindersByUser.get(userId);
    if (!list) {
      return 0;
    }
    const count = list.length;
    list.length = 0;
    return count;
  }

  collectDue(now: Date = this.#now()): readonly { readonly userId: string; readonly reminder: SlackReminder }[] {
    const result: { readonly userId: string; readonly reminder: SlackReminder }[] = [];
    for (const [userId, list] of this.#remindersByUser.entries()) {
      const due = list.filter((entry) => entry.dueAt !== undefined && entry.dueAt.getTime() <= now.getTime());
      if (due.length === 0) {
        continue;
      }
      this.#remindersByUser.set(
        userId,
        list.filter((entry) => !due.includes(entry))
      );
      for (const reminder of due) {
        result.push({ reminder, userId });
      }
    }
    return result;
  }
}

export interface SlackReminderPollerOptions {
  readonly store: ReminderStore;
  readonly messageTransport: SlackMessageTransport;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

export interface SlackReminderPoller {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createSlackReminderPoller(options: SlackReminderPollerOptions): SlackReminderPoller {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    const due = options.store.collectDue(options.now ? options.now() : new Date());
    for (const entry of due) {
      try {
        await options.messageTransport.postMessage({
          channelId: entry.userId,
          text: `:bell: *Reminder #${entry.reminder.id}*\n${entry.reminder.text}`
        });
      } catch (error) {
        options.logger?.("SlackReminderPoller dispatch failed", error);
      }
    }
  };

  return {
    start: (): void => {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop: (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick
  };
}

export interface SlackReminderCommandResult {
  readonly text: string;
}

export function handleSlackReminderCommand(
  store: ReminderStore,
  userId: string,
  args: string
): SlackReminderCommandResult {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "list") {
    const reminders = store.list(userId);
    if (reminders.length === 0) {
      return { text: "리마인더가 없어요." };
    }
    return {
      text: reminders
        .map((reminder) => formatReminderListEntry(reminder))
        .join("\n")
    };
  }

  const [command, ...rest] = trimmed.split(/\s+/u);
  const remaining = rest.join(" ").trim();

  if (command === "add") {
    if (remaining.length === 0) {
      return { text: "리마인더 내용을 입력하세요. 예: `/muse remind add 3시에 회의 준비`" };
    }
    const created = store.add(userId, remaining);
    if (created.dueAt) {
      return { text: `리마인더 #${created.id} 등록 (${created.dueAt.toISOString()}): ${created.text}` };
    }
    return { text: `리마인더 #${created.id} 등록 (시간 미지정): ${created.text}` };
  }

  if (command === "done") {
    const id = Number.parseInt(remaining, 10);
    if (!Number.isFinite(id)) {
      return { text: "리마인더 ID를 입력하세요. 예: `/muse remind done 3`" };
    }
    const removed = store.done(userId, id);
    return { text: removed ? `리마인더 #${removed.id} 완료 처리.` : `리마인더 #${id}을(를) 찾을 수 없어요.` };
  }

  if (command === "clear") {
    const removed = store.clear(userId);
    return { text: removed > 0 ? `리마인더 ${removed}건 삭제.` : "삭제할 리마인더가 없어요." };
  }

  return { text: "지원하는 명령: `add`, `list`, `done <id>`, `clear`" };
}

function formatReminderListEntry(reminder: SlackReminder): string {
  if (reminder.dueAt) {
    return `#${reminder.id} (${reminder.dueAt.toISOString()}): ${reminder.text}`;
  }
  return `#${reminder.id} (시간 미지정): ${reminder.text}`;
}
