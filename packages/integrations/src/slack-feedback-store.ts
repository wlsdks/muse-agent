/**
 * Slack feedback-event primitives extracted from
 * packages/integrations/src/index.ts.
 *
 * Owns the in-memory and Kysely-backed `SlackFeedbackEventStore`
 * implementations, the `SlackFeedbackButtonHandler` SlackInteractionHandler
 * (consumes thumbs-up/down clicks, looks up the tracked bot response,
 * persists feedback, replies with an ephemeral ack), and the row mappers
 * (`createSlackFeedbackEventInsert` / `mapSlackFeedbackEventRow`).
 *
 * Re-exported from the integrations barrel for backwards compatibility.
 */

import type { MuseDatabase, SlackFeedbackEventTable } from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";
import type {
  Awaitable,
  SlackBotResponseTracker,
  SlackFeedbackEvent,
  SlackFeedbackEventStore,
  SlackFeedbackInput,
  SlackInteractionHandler,
  SlackInteractionPayload,
  SlackMessageTransport,
  SlackResponseUrlTransport
} from "./index.js";

type SlackFeedbackEventRow = Selectable<SlackFeedbackEventTable>;
type SlackFeedbackEventInsert = Insertable<SlackFeedbackEventTable>;

export class InMemorySlackFeedbackEventStore implements SlackFeedbackEventStore {
  private readonly events: SlackFeedbackEvent[] = [];
  private readonly idFactory: () => string;
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(options: {
    readonly idFactory?: () => string;
    readonly maxEvents?: number;
    readonly now?: () => Date;
  } = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("slack_feedback"));
    this.maxEvents = Math.max(1, options.maxEvents ?? 50_000);
    this.now = options.now ?? (() => new Date());
  }

  save(input: SlackFeedbackInput): SlackFeedbackEvent {
    const event = normalizeSlackFeedbackEvent(input, {
      createdAt: this.now(),
      id: this.idFactory()
    });

    this.events.push(event);

    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  listBySession(sessionId: string): readonly SlackFeedbackEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}

export class KyselySlackFeedbackEventStore implements SlackFeedbackEventStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: {
      readonly idFactory?: () => string;
      readonly now?: () => Date;
    } = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("slack_feedback"));
    this.now = options.now ?? (() => new Date());
  }

  async save(input: SlackFeedbackInput): Promise<SlackFeedbackEvent> {
    const event = normalizeSlackFeedbackEvent(input, {
      createdAt: this.now(),
      id: this.idFactory()
    });
    const row = createSlackFeedbackEventInsert(event);

    const saved = await this.db
      .insertInto("slack_feedback_events")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapSlackFeedbackEventRow(saved);
  }

  async listBySession(sessionId: string): Promise<readonly SlackFeedbackEvent[]> {
    const rows = await this.db
      .selectFrom("slack_feedback_events")
      .selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapSlackFeedbackEventRow);
  }
}

export class SlackFeedbackButtonHandler implements SlackInteractionHandler {
  readonly actionIdPrefix = "feedback";

  constructor(private readonly options: {
    readonly messageTransport?: SlackMessageTransport;
    readonly onFeedback: (feedback: SlackFeedbackInput) => Awaitable<void>;
    readonly responseTransport?: SlackResponseUrlTransport;
    readonly feedbackStore?: SlackFeedbackEventStore;
    readonly tracker: SlackBotResponseTracker;
  }) {}

  async handle(payload: SlackInteractionPayload): Promise<boolean> {
    const rating = feedbackRatingFromAction(payload.actionId);

    if (!rating) {
      return true;
    }

    if (!payload.channelId || !payload.messageTs) {
      return true;
    }

    const tracked = await this.options.tracker.lookup(payload.channelId, payload.messageTs);

    if (!tracked) {
      if (payload.responseUrl && this.options.responseTransport) {
        await this.options.responseTransport.post(payload.responseUrl, {
          response_type: "ephemeral",
          text: "This message is expired or no longer tracked."
        });
      }

      return true;
    }

    const feedback = {
      channelId: payload.channelId,
      messageTs: payload.messageTs,
      metadata: {
        actionId: payload.actionId,
        responseUrl: payload.responseUrl ?? null,
        type: payload.type
      },
      query: tracked.userPrompt,
      rating,
      response: tracked.response ?? "",
      sessionId: tracked.sessionId,
      userId: payload.userId
    } satisfies SlackFeedbackInput;
    const saved = await toBooleanPromise((async () => {
      await this.options.feedbackStore?.save(feedback);
      await this.options.onFeedback(feedback);
    })());
    const ackText = saved
      ? rating === "thumbs_up"
        ? "Thanks for the feedback. I will keep improving."
        : "Thanks for the candid feedback. I will do better next time."
      : "Feedback was received, but saving failed.";

    await this.options.messageTransport?.postMessage({
      channelId: payload.channelId,
      text: ackText,
      threadTs: payload.messageTs
    });

    return true;
  }
}

export function createSlackFeedbackEventInsert(event: SlackFeedbackEvent): SlackFeedbackEventInsert {
  return {
    channel_id: event.channelId,
    created_at: event.createdAt,
    id: event.id,
    message_ts: event.messageTs,
    metadata: event.metadata ?? {},
    query: event.query,
    rating: event.rating,
    response: event.response,
    session_id: event.sessionId,
    user_id: event.userId
  };
}

export function mapSlackFeedbackEventRow(row: SlackFeedbackEventRow | SlackFeedbackEventInsert): SlackFeedbackEvent {
  return {
    channelId: row.channel_id ?? "",
    createdAt: dateValue(row.created_at ?? null),
    id: row.id ?? "",
    messageTs: row.message_ts ?? "",
    metadata: jsonObjectValue(row.metadata),
    query: row.query ?? "",
    rating: row.rating === "thumbs_down" ? "thumbs_down" : "thumbs_up",
    response: row.response ?? "",
    sessionId: row.session_id ?? "",
    userId: row.user_id ?? ""
  };
}

function normalizeSlackFeedbackEvent(
  input: SlackFeedbackInput,
  generated: { readonly createdAt: Date; readonly id: string }
): SlackFeedbackEvent {
  return {
    channelId: input.channelId?.trim() || "unknown",
    createdAt: generated.createdAt,
    id: generated.id,
    messageTs: input.messageTs?.trim() || "unknown",
    metadata: input.metadata ?? {},
    query: input.query,
    rating: input.rating,
    response: input.response,
    sessionId: input.sessionId,
    userId: input.userId
  };
}

function feedbackRatingFromAction(actionId: string): "thumbs_down" | "thumbs_up" | undefined {
  const subAction = actionId.startsWith("feedback.") ? actionId.slice("feedback.".length) : "";

  if (subAction === "up") {
    return "thumbs_up";
  }

  return subAction === "down" ? "thumbs_down" : undefined;
}

async function toBooleanPromise(input: Awaitable<void>): Promise<boolean> {
  try {
    await input;
    return true;
  } catch {
    return false;
  }
}

function dateValue(value: Date | string | null): Date {
  return value instanceof Date ? value : new Date(value ?? 0);
}

function jsonObjectValue(value: unknown): JsonObject {
  if (typeof value === "string") {
    return (parseJsonObject(value) as JsonObject | undefined) ?? {};
  }

  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
