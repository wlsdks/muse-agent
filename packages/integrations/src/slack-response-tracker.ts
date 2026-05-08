/**
 * Slack response-tracking primitives extracted from
 * packages/integrations/src/index.ts.
 *
 * Owns the in-memory and Kysely-backed `SlackResponseTrackerStore`
 * implementations, the `SlackBotResponseTracker` facade with TTL +
 * default-store wiring, and the DB row mappers
 * (`createSlackResponseTrackingInsert` /
 * `mapSlackResponseTrackingRow`).
 *
 * Re-exported from the integrations barrel for backwards compatibility.
 */

import type { MuseDatabase, SlackResponseTrackingTable } from "@muse/db";
import type { Insertable, Kysely, Selectable } from "kysely";
import type {
  Awaitable,
  SlackResponseTrackerStore,
  SlackResponseTrackingInput,
  TrackedSlackBotResponse
} from "./index.js";

type SlackResponseTrackingRow = Selectable<SlackResponseTrackingTable>;
type SlackResponseTrackingInsert = Insertable<SlackResponseTrackingTable>;

export class InMemorySlackResponseTrackerStore implements SlackResponseTrackerStore {
  private readonly entries = new Map<string, SlackResponseTrackingInput>();
  private readonly maxEntries: number;

  constructor(options: { readonly maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 50_000);
  }

  track(input: SlackResponseTrackingInput): void {
    if (input.channelId.trim().length === 0 || input.messageTs.trim().length === 0) {
      return;
    }

    this.entries.set(slackResponseKey(input.channelId, input.messageTs), input);
    this.trim(input.expiresAt - 1);
  }

  lookup(channelId: string, messageTs: string, now: number = Date.now()): TrackedSlackBotResponse | undefined {
    const key = slackResponseKey(channelId, messageTs);
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    return {
      expiresAt: entry.expiresAt,
      response: entry.response,
      sessionId: entry.sessionId,
      userPrompt: entry.userPrompt
    };
  }

  purgeExpired(now: number = Date.now()): number {
    let deleted = 0;

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  private trim(now: number): void {
    this.purgeExpired(now);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;

      if (!oldest) {
        return;
      }

      this.entries.delete(oldest);
    }
  }
}

export class KyselySlackResponseTrackerStore implements SlackResponseTrackerStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async track(input: SlackResponseTrackingInput): Promise<void> {
    if (input.channelId.trim().length === 0 || input.messageTs.trim().length === 0) {
      return;
    }

    const row = createSlackResponseTrackingInsert(input, { now: this.now });
    await this.db
      .insertInto("slack_response_tracking")
      .values(row)
      .onConflict((oc) => oc.columns(["channel_id", "message_ts"]).doUpdateSet({
        expires_at: row.expires_at,
        response: row.response,
        session_id: row.session_id,
        updated_at: row.updated_at,
        user_prompt: row.user_prompt
      }))
      .executeTakeFirst();
  }

  async lookup(channelId: string, messageTs: string, now: number = Date.now()): Promise<TrackedSlackBotResponse | undefined> {
    const row = await this.db
      .selectFrom("slack_response_tracking")
      .selectAll()
      .where("channel_id", "=", channelId)
      .where("message_ts", "=", messageTs)
      .executeTakeFirst();

    if (!row) {
      return undefined;
    }

    const tracked = mapSlackResponseTrackingRow(row);

    if (tracked.expiresAt <= now) {
      await this.db
        .deleteFrom("slack_response_tracking")
        .where("channel_id", "=", channelId)
        .where("message_ts", "=", messageTs)
        .executeTakeFirst();
      return undefined;
    }

    return tracked;
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    const result = await this.db
      .deleteFrom("slack_response_tracking")
      .where("expires_at", "<=", new Date(now))
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

export class SlackBotResponseTracker {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: SlackResponseTrackerStore;

  constructor(options: {
    readonly maxEntries?: number;
    readonly now?: () => number;
    readonly store?: SlackResponseTrackerStore;
    readonly ttlMs?: number;
  } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new InMemorySlackResponseTrackerStore({ maxEntries: options.maxEntries });
    this.ttlMs = Math.max(1, options.ttlMs ?? 86_400_000);
  }

  track(
    channelId: string,
    messageTs: string,
    sessionId: string,
    userPrompt: string,
    response?: string
  ): Awaitable<void> {
    if (channelId.trim().length === 0 || messageTs.trim().length === 0) {
      return;
    }

    return this.store.track({
      channelId,
      expiresAt: this.now() + this.ttlMs,
      messageTs,
      response,
      sessionId,
      userPrompt
    });
  }

  lookup(channelId: string, messageTs: string): Awaitable<TrackedSlackBotResponse | undefined> {
    return this.store.lookup(channelId, messageTs, this.now());
  }

  purgeExpired(): Awaitable<number> {
    return this.store.purgeExpired(this.now());
  }
}

export function createSlackResponseTrackingInsert(
  input: SlackResponseTrackingInput,
  options: { readonly now: () => Date }
): SlackResponseTrackingInsert {
  const now = options.now();

  return {
    channel_id: input.channelId,
    created_at: now,
    expires_at: new Date(input.expiresAt),
    message_ts: input.messageTs,
    response: input.response ?? null,
    session_id: input.sessionId,
    updated_at: now,
    user_prompt: input.userPrompt
  };
}

export function mapSlackResponseTrackingRow(
  row: SlackResponseTrackingRow | SlackResponseTrackingInsert
): TrackedSlackBotResponse {
  return {
    expiresAt: dateValue(row.expires_at ?? null).getTime(),
    response: row.response ?? undefined,
    sessionId: row.session_id ?? "",
    userPrompt: row.user_prompt ?? ""
  };
}

function slackResponseKey(channelId: string, messageTs: string): string {
  return `${channelId}:${messageTs}`;
}

function dateValue(value: Date | string | null): Date {
  return value instanceof Date ? value : new Date(value ?? 0);
}
