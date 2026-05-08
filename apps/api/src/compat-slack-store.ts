/**
 * Reactor-compat Slack-bot + proactive-channel store helpers extracted
 * from reactor-compat-routes.ts.
 *
 * Slack-bot helpers dispatch to options.slackPersistence?.botStore (a
 * SlackBotInstanceStore) when configured, otherwise fall back to compat
 * state via getStateSlackBots. Proactive-channel helpers persist their
 * list to options.runtimeSettings under a stable key.
 */

import type { SlackBotInstance } from "@muse/integrations";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyReply } from "fastify";
import {
  compatRecord,
  createRecord,
  dateOrUndefined,
  epochMillisOrNull,
  errorResponse,
  findCompatRecord,
  getStateSlackBots,
  nowIso,
  nullableStringResponse,
  readBodyString,
  readBoolean,
  readNullableStringField,
  readNumber,
  readOptionalStringField,
  stringField,
  toBody,
  toJsonObject,
  type CompatBody,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

const PROACTIVE_CHANNELS_SETTING_KEY = "compat.slack.proactiveChannels";

export async function listProactiveChannels(options: ReactorCompatibilityRouteOptions): Promise<readonly CompatRecord[]> {
  const records = await options.runtimeSettings.getJson(PROACTIVE_CHANNELS_SETTING_KEY, []);
  return records
    .map(toJsonObject)
    .map((record) => compatRecord(record, "proactive_channel", record))
    .filter((record) => stringField(record.channelId, "").length > 0);
}

export async function saveProactiveChannels(
  options: ReactorCompatibilityRouteOptions,
  records: readonly JsonObject[]
): Promise<void> {
  await options.runtimeSettings.set({
    category: "slack",
    description: "Reactor-compatible proactive Slack channel list",
    key: PROACTIVE_CHANNELS_SETTING_KEY,
    type: "json",
    value: JSON.stringify(records)
  });
}

export async function createSlackBot(
  options: ReactorCompatibilityRouteOptions,
  bodyValue: unknown
): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  const record = {
    appToken: readBodyString(body, "appToken") ?? "",
    botToken: readBodyString(body, "botToken") ?? "",
    defaultChannel: readNullableStringField(body, "defaultChannel"),
    enabled: readBoolean(body.enabled, true),
    id: typeof body.id === "string" && body.id.length > 0 ? body.id : createRunId("slack_bot"),
    name: readBodyString(body, "name") ?? "",
    personaId: readBodyString(body, "personaId") ?? ""
  };

  if (options.slackPersistence?.botStore) {
    return slackBotToCompat(await options.slackPersistence.botStore.save(compatToSlackBot(record)));
  }

  return createRecord(getStateSlackBots(), record, "slack_bot");
}

export function validateSlackBotCreate(body: CompatBody): JsonObject | undefined {
  if (!readBodyString(body, "name")) {
    return { name: "name은 필수입니다" };
  }

  if (typeof body.name === "string" && body.name.length > 100) {
    return { name: "size must be between 0 and 100" };
  }

  if (!readBodyString(body, "botToken")) {
    return { botToken: "botToken은 필수입니다" };
  }

  if (!readBodyString(body, "appToken")) {
    return { appToken: "appToken은 필수입니다" };
  }

  if (!readBodyString(body, "personaId")) {
    return { personaId: "personaId는 필수입니다" };
  }

  return undefined;
}

export async function listSlackBots(options: ReactorCompatibilityRouteOptions): Promise<readonly JsonObject[]> {
  if (options.slackPersistence?.botStore) {
    const bots = await options.slackPersistence.botStore.list();
    return bots.map(slackBotToCompat);
  }

  return [...getStateSlackBots().values()];
}

export async function getSlackBot(options: ReactorCompatibilityRouteOptions, id: string): Promise<JsonObject | undefined> {
  if (options.slackPersistence?.botStore) {
    const bot = await options.slackPersistence.botStore.get(id);
    return bot ? slackBotToCompat(bot) : undefined;
  }

  return findCompatRecord(getStateSlackBots(), id);
}

export async function deleteSlackBot(options: ReactorCompatibilityRouteOptions, id: string): Promise<boolean> {
  if (options.slackPersistence?.botStore) {
    return options.slackPersistence.botStore.delete(id);
  }

  return getStateSlackBots().delete(id);
}

function compatToSlackBot(record: JsonObject): SlackBotInstance {
  return {
    appToken: stringField(record.appToken, ""),
    botToken: stringField(record.botToken, ""),
    createdAt: dateOrUndefined(record.createdAt),
    defaultChannel: nullableStringResponse(record.defaultChannel),
    enabled: readBoolean(record.enabled, true),
    id: stringField(record.id, createRunId("slack_bot")),
    name: stringField(record.name, ""),
    personaId: stringField(record.personaId, ""),
    updatedAt: dateOrUndefined(record.updatedAt)
  };
}

function slackBotToCompat(bot: SlackBotInstance): CompatRecord {
  return {
    appToken: bot.appToken,
    botToken: bot.botToken,
    createdAt: (bot.createdAt ?? new Date()).toISOString(),
    defaultChannel: bot.defaultChannel ?? null,
    enabled: bot.enabled ?? true,
    id: bot.id,
    name: bot.name,
    personaId: bot.personaId,
    updatedAt: (bot.updatedAt ?? bot.createdAt ?? new Date()).toISOString()
  };
}

export async function updateSlackBot(
  options: ReactorCompatibilityRouteOptions,
  existing: JsonObject,
  bodyValue: unknown
): Promise<CompatRecord> {
  const body = toBody(bodyValue);
  const record = {
    ...existing,
    appToken: readBodyString(body, "appToken") ?? stringField(existing.appToken, ""),
    botToken: readBodyString(body, "botToken") ?? stringField(existing.botToken, ""),
    defaultChannel: readOptionalStringField(body, "defaultChannel", existing.defaultChannel),
    enabled: readBoolean(body.enabled, readBoolean(existing.enabled, true)),
    name: readBodyString(body, "name") ?? stringField(existing.name, ""),
    personaId: readBodyString(body, "personaId") ?? stringField(existing.personaId, "")
  };

  if (options.slackPersistence?.botStore) {
    return slackBotToCompat(await options.slackPersistence.botStore.save(compatToSlackBot(record)));
  }

  return createRecord(getStateSlackBots(), record, "slack_bot");
}

export function toSlackBotResponse(record: JsonObject) {
  return {
    appTokenMasked: maskSlackToken(record.appToken),
    botTokenMasked: maskSlackToken(record.botToken),
    createdAt: stringField(record.createdAt, nowIso()),
    defaultChannel: nullableStringResponse(record.defaultChannel),
    enabled: readBoolean(record.enabled, true),
    id: stringField(record.id, ""),
    name: stringField(record.name, ""),
    personaId: stringField(record.personaId, ""),
    updatedAt: stringField(record.updatedAt, nowIso())
  };
}

export function slackBotNotFound(reply: FastifyReply, id: string) {
  return reply.status(404).send(errorResponse(`봇 인스턴스를 찾을 수 없습니다: ${id}`));
}

export function toProactiveChannelResponse(record: JsonObject) {
  return {
    addedAt: readNumber(record.addedAt, epochMillisOrNull(record.createdAt) ?? Date.now()),
    channelId: stringField(record.channelId, ""),
    channelName: nullableStringResponse(record.channelName)
  };
}

function maskSlackToken(value: unknown): string {
  const token = typeof value === "string" ? value : "";
  return `${token.slice(0, 6)}***`;
}
