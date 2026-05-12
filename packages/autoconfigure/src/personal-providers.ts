/**
 * Personal-domain provider builders + env-driven path resolvers.
 *
 * Lifted out of `packages/autoconfigure/src/index.ts` (1,255 LOC,
 * the largest source file in the repo after the round 139-142 mcp
 * splits) so the JARVIS-personal wiring — Notes / Tasks / Calendar
 * / Voice — lives in its own focused module.
 *
 * What's here:
 *   - Default-path resolvers for the personal-domain trio's local
 *     storage: notes dir, tasks file, local calendar file, plus the
 *     credentials JSON file consumed by remote calendar providers
 *   - `buildCalendarRegistry` + `tryBuildCalendarProvider` — env +
 *     credentials → `CalendarProviderRegistry` with any registered
 *     subset of: local / gcal / caldav / macos
 *   - `buildVoiceRegistry` — env → `VoiceProviderRegistry` with
 *     OpenAI Whisper + TTS-1 when an API key is available
 *   - `ensureNotesDir` — best-effort `mkdir -p` so the inline
 *     Notes MCP server has a directory to land into
 *
 * The shape of `MuseEnvironment` stays in `index.ts`; this module
 * imports it back as a type-only consumer.
 */

import { mkdirSync } from "node:fs";

import {
  CalDAVCalendarProvider,
  CalendarProviderRegistry,
  GoogleCalendarProvider,
  LocalCalendarProvider,
  MacOsCalendarProvider,
  type CalendarEvent,
  type CalendarProvider
} from "@muse/calendar";
import {
  AppleNotesProvider,
  AppleRemindersProvider,
  LocalDirNotesProvider,
  LocalFileTasksProvider,
  NotesProviderRegistry,
  NotionNotesProvider,
  NotionTasksProvider,
  TasksProviderRegistry,
  readReminders,
  type NotesProvider,
  type TasksProvider
} from "@muse/mcp";
import {
  DiscordProvider,
  FileBackedInboxContextProvider,
  LineProvider,
  MessagingProviderRegistry,
  SlackProvider,
  TelegramProvider,
  type InboxSourceConfig,
  type MessagingProvider
} from "@muse/messaging";
import {
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  VoiceProviderRegistry
} from "@muse/voice";
import {
  DefaultActiveContextProvider,
  DefaultToolFilter,
  InMemoryTelemetryAggregator,
  StoreBackedEpisodicRecallProvider,
  type ActiveContextProvider,
  type EpisodicRecallProvider,
  type InboxContextProvider,
  type ReminderHint,
  type RemindersResolver,
  type SkillCatalogEntry,
  type SkillCatalogProvider,
  type TelemetryAggregator,
  type ToolFilter
} from "@muse/agent-core";
import type { ConversationSummaryStore, TaskMemoryStore, UserMemoryStore } from "@muse/memory";
import {
  FileSystemSkillLoader,
  InMemorySkillRegistry,
  type Skill,
  type SkillRegistry
} from "@muse/skills";

import type { MuseEnvironment } from "./index.js";
import { OPENAI_COMPAT_PRESETS } from "./openai-compat-presets.js";
import { clampPositive, readCredentialsSync, stringField } from "./provider-utils.js";

import {
  resolveCredentialsFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveUserSkillsDir,
  resolveWorkspaceSkillsDir
} from "./provider-paths.js";

export {
  resolveCredentialsFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveUserSkillsDir,
  resolveWorkspaceSkillsDir
} from "./provider-paths.js";

/**
 * Merge model API keys saved by `muse setup model` into the env
 * record. Env always wins on conflict — a one-off shell export
 * stays effective. The file shape comes from `setup-model.ts`:
 *   { providers: { openai: { token, suggestedModel }, ... } }
 *
 * Recognised file ids → env keys:
 *   openai      → OPENAI_API_KEY
 *   anthropic   → ANTHROPIC_API_KEY
 *   gemini      → GEMINI_API_KEY
 *   openrouter  → OPENROUTER_API_KEY
 *   ollama      → OLLAMA_BASE_URL  (the file's `token` field is
 *                                   the URL, not a secret)
 *
 * Sync read by design — `createMuseRuntimeAssembly` is sync and
 * reads env directly; the file fallback rides the same path.
 */
export function mergeModelKeysFromFile(env: MuseEnvironment): MuseEnvironment {
  const file = readCredentialsSync(resolveModelKeysFile(env));
  if (Object.keys(file).length === 0) {
    return env;
  }
  const fileKeyForEnv: Record<string, string | undefined> = {};
  const legacy: ReadonlyArray<{ id: string; envKey: string }> = [
    { envKey: "OPENAI_API_KEY", id: "openai" },
    { envKey: "ANTHROPIC_API_KEY", id: "anthropic" },
    { envKey: "GEMINI_API_KEY", id: "gemini" },
    { envKey: "OPENROUTER_API_KEY", id: "openrouter" },
    { envKey: "OLLAMA_BASE_URL", id: "ollama" }
  ];
  const map: ReadonlyArray<{ id: string; envKey: string }> = [
    ...legacy,
    ...Object.entries(OPENAI_COMPAT_PRESETS).map(([id, preset]) => ({ envKey: preset.envKey, id }))
  ];
  let firstSuggestedModel: string | undefined;
  for (const entry of map) {
    const token = stringField(file[entry.id], "token");
    if (token && token.length > 0) {
      fileKeyForEnv[entry.envKey] = token;
      // Capture the first provider's `suggestedModel` so `setup model`
      // produces a turnkey configuration — without it the user has to
      // separately `export MUSE_MODEL=...` even though the wizard
      // already asked them to pick a provider.
      if (firstSuggestedModel === undefined) {
        const suggested = stringField(file[entry.id], "suggestedModel");
        if (suggested && suggested.length > 0) {
          firstSuggestedModel = suggested;
        }
      }
    }
  }
  if (Object.keys(fileKeyForEnv).length === 0) {
    return env;
  }
  // Env wins: spread file first, env second. MUSE_MODEL only falls
  // back to the file value when env doesn't already have one.
  if (firstSuggestedModel !== undefined) {
    fileKeyForEnv["MUSE_MODEL"] = firstSuggestedModel;
  }
  return { ...fileKeyForEnv, ...env };
}

export function buildCalendarRegistry(env: MuseEnvironment): CalendarProviderRegistry {
  const registry = new CalendarProviderRegistry();
  const requested = (env.MUSE_CALENDAR_PROVIDERS?.trim() || "local")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const credentials = readCredentialsSync(resolveCredentialsFile(env));

  for (const id of requested) {
    const provider = tryBuildCalendarProvider(id, env, credentials[id]);
    if (provider) {
      registry.register(provider);
    }
  }

  return registry;
}

function tryBuildCalendarProvider(
  id: string,
  env: MuseEnvironment,
  credentials: { readonly [key: string]: unknown } | undefined
): CalendarProvider | undefined {
  if (id === "local") {
    return new LocalCalendarProvider({ file: resolveLocalCalendarFile(env) });
  }

  if (id === "gcal") {
    const clientId = stringField(credentials, "clientId") ?? env.MUSE_GCAL_CLIENT_ID;
    const clientSecret = stringField(credentials, "clientSecret") ?? env.MUSE_GCAL_CLIENT_SECRET;
    const refreshToken = stringField(credentials, "refreshToken") ?? env.MUSE_GCAL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      return undefined;
    }
    return new GoogleCalendarProvider({
      calendarId: stringField(credentials, "calendarId") ?? env.MUSE_GCAL_CALENDAR_ID ?? "primary",
      clientId,
      clientSecret,
      refreshToken
    });
  }

  if (id === "caldav") {
    const url = stringField(credentials, "url") ?? env.MUSE_CALDAV_URL;
    const username = stringField(credentials, "username") ?? env.MUSE_CALDAV_USERNAME;
    const password = stringField(credentials, "password") ?? env.MUSE_CALDAV_APP_PASSWORD;
    if (!url || !username || !password) {
      return undefined;
    }
    return new CalDAVCalendarProvider({ password, url, username });
  }

  if (id === "macos") {
    const calendarName = stringField(credentials, "calendarName") ?? env.MUSE_MACOS_CALENDAR_NAME;
    return new MacOsCalendarProvider(calendarName ? { calendarName } : {});
  }

  return undefined;
}

/**
 * Build a `NotesProviderRegistry` from env. Always registers
 * `LocalDirNotesProvider` (rooted at `MUSE_NOTES_DIR` resolved via
 * `resolveNotesDir`) so the agent has at least filesystem-backed
 * notes. Apple Notes (osascript, macOS-only) and Notion (api.notion.com)
 * register opt-in via `MUSE_NOTES_PROVIDERS`.
 *
 * Env (resolution order):
 *   - `MUSE_NOTES_PROVIDERS` — comma-separated subset of
 *     `local,apple,notion`. Defaults to `local`. Adding `apple`
 *     registers an `AppleNotesProvider`; the `osascript` calls fail
 *     with `NOTES_PERMISSION` until the user grants Notes access on
 *     macOS, but the registry itself is built unconditionally so
 *     the agent gets a typed error rather than a missing tool.
 *   - `MUSE_APPLE_NOTES_FOLDER` — optional folder filter for Apple
 *     Notes (default: every note).
 *   - Notion token resolution: `providers.notion.token` from the
 *     credentials file (`MUSE_CREDENTIALS_FILE`, default
 *     `~/.muse/credentials.json`) → `MUSE_NOTION_TOKEN` env. Without
 *     a token, Notion is silently skipped (the agent gets one
 *     fewer provider).
 *   - `MUSE_NOTION_DATABASE_ID` / `MUSE_NOTION_TITLE_PROPERTY` —
 *     overrides for the database scope and title-property name.
 *
 * The registry is composed; the caller decides whether to register
 * the registry-aware MCP server (`createNotesRegistryMcpServer`) on
 * top of the inline filesystem-only `createNotesMcpServer`.
 */
export function buildNotesRegistry(env: MuseEnvironment): NotesProviderRegistry {
  const registry = new NotesProviderRegistry();
  const requested = (env.MUSE_NOTES_PROVIDERS?.trim() || "local")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const credentials = readCredentialsSync(resolveCredentialsFile(env));

  for (const id of requested) {
    const provider = tryBuildNotesProvider(id, env, credentials[id]);
    if (provider) {
      registry.register(provider);
    }
  }

  return registry;
}

function tryBuildNotesProvider(
  id: string,
  env: MuseEnvironment,
  credentials: { readonly [key: string]: unknown } | undefined
): NotesProvider | undefined {
  if (id === "local") {
    return new LocalDirNotesProvider({ notesDir: resolveNotesDir(env) });
  }

  if (id === "apple") {
    const folder = stringField(credentials, "folder") ?? env.MUSE_APPLE_NOTES_FOLDER;
    return new AppleNotesProvider(folder ? { folder } : {});
  }

  if (id === "notion") {
    const token = stringField(credentials, "token") ?? env.MUSE_NOTION_TOKEN;
    if (!token) {
      return undefined;
    }
    const databaseId = stringField(credentials, "databaseId") ?? env.MUSE_NOTION_DATABASE_ID;
    const titleProperty = stringField(credentials, "titleProperty") ?? env.MUSE_NOTION_TITLE_PROPERTY;
    return new NotionNotesProvider({
      token,
      ...(databaseId ? { databaseId } : {}),
      ...(titleProperty ? { titleProperty } : {})
    });
  }

  return undefined;
}

/**
 * Build a `TasksProviderRegistry` from env. Always registers
 * `LocalFileTasksProvider` (rooted at `MUSE_TASKS_FILE` resolved via
 * `resolveTasksFile`) so the agent has at least filesystem-backed
 * tasks. Apple Reminders (osascript, macOS-only) and Notion DB
 * (round 169) register opt-in via `MUSE_TASKS_PROVIDERS`.
 *
 * Env (resolution order):
 *   - `MUSE_TASKS_PROVIDERS` — comma-separated subset of
 *     `local,apple-reminders,notion`. Defaults to `local`. Adding
 *     `apple-reminders` registers an `AppleRemindersProvider`; the
 *     osascript calls fail with `REMINDERS_PERMISSION` until the
 *     user grants Reminders access on macOS, but the registry
 *     itself is built unconditionally so the agent surfaces a typed
 *     error rather than a missing tool. Adding `notion` requires
 *     `MUSE_NOTION_TASKS_TOKEN` + `MUSE_NOTION_TASKS_DATABASE_ID`;
 *     when either is missing the entry is silently skipped.
 *   - `MUSE_APPLE_REMINDERS_LIST` — optional list scope (e.g.
 *     "Groceries", "Work"). Default: every list, add lands in the
 *     default Reminders list.
 *   - `MUSE_NOTION_TASKS_TOKEN` — Notion integration token.
 *   - `MUSE_NOTION_TASKS_DATABASE_ID` — Notion database id (32-char).
 *   - `MUSE_NOTION_TASKS_TITLE_PROPERTY` — title-property name
 *     (default `Name`).
 *   - `MUSE_NOTION_TASKS_STATUS_PROPERTY` — select-property name
 *     (default `Status`).
 *   - `MUSE_NOTION_TASKS_STATUS_OPEN` / `..._STATUS_DONE` — option
 *     names (default `Open` / `Done`).
 *
 * The caller decides whether to register the registry-aware MCP
 * server (`createTasksRegistryMcpServer`) on top of the inline
 * filesystem-only `createTasksMcpServer`.
 */
export function buildTasksRegistry(env: MuseEnvironment): TasksProviderRegistry {
  const registry = new TasksProviderRegistry();
  const requested = (env.MUSE_TASKS_PROVIDERS?.trim() || "local")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const id of requested) {
    const provider = tryBuildTasksProvider(id, env);
    if (provider) {
      registry.register(provider);
    }
  }

  return registry;
}

function tryBuildTasksProvider(id: string, env: MuseEnvironment): TasksProvider | undefined {
  if (id === "local") {
    return new LocalFileTasksProvider({ file: resolveTasksFile(env) });
  }

  if (id === "apple-reminders") {
    const list = env.MUSE_APPLE_REMINDERS_LIST?.trim();
    return new AppleRemindersProvider(list ? { list } : {});
  }

  if (id === "notion") {
    const token = env.MUSE_NOTION_TASKS_TOKEN?.trim();
    const databaseId = env.MUSE_NOTION_TASKS_DATABASE_ID?.trim();
    if (!token || !databaseId) {
      // Silently skip — explicit opt-in via MUSE_TASKS_PROVIDERS but
      // missing credentials means the user hasn't finished setup yet.
      return undefined;
    }
    const titleProperty = env.MUSE_NOTION_TASKS_TITLE_PROPERTY?.trim();
    const statusProperty = env.MUSE_NOTION_TASKS_STATUS_PROPERTY?.trim();
    const statusOpenValue = env.MUSE_NOTION_TASKS_STATUS_OPEN?.trim();
    const statusDoneValue = env.MUSE_NOTION_TASKS_STATUS_DONE?.trim();
    return new NotionTasksProvider({
      databaseId,
      token,
      ...(titleProperty ? { titleProperty } : {}),
      ...(statusProperty ? { statusProperty } : {}),
      ...(statusOpenValue ? { statusOpenValue } : {}),
      ...(statusDoneValue ? { statusDoneValue } : {})
    });
  }

  return undefined;
}

/**
 * Build a `VoiceProviderRegistry` from env when voice credentials are
 * available. Returns `undefined` when nothing was registered so the
 * `/api/voice/*` routes stay absent (404) by default.
 *
 * Today only OpenAI (Whisper STT + TTS-1) is recognized — the package
 * `@muse/voice` ships those adapters as Phase B. Future iterations
 * (Phase F) can add Whisper.cpp / Piper / ElevenLabs / Gemini Live
 * here without changing the route surface.
 *
 * Env (resolution order):
 *   - `MUSE_VOICE_OPENAI_API_KEY` — Muse-specific override. Set this
 *     to use a different OpenAI key for voice than for the chat
 *     model (e.g. separate billing).
 *   - `OPENAI_API_KEY` — standard OpenAI SDK convention. The chat
 *     model already uses this as a fallback, so a personal user who
 *     sets it once gets both chat AND voice for free.
 *   - When neither is set, the registry is empty and the routes are
 *     not registered (404). The earlier `MUSE_OPENAI_API_KEY` name
 *     was a one-iter mismatch with both conventions — dropped.
 *   - `MUSE_VOICE_TTS_VOICE` — default voice (alloy / echo / fable /
 *     onyx / nova / shimmer). Defaults to `alloy`.
 *   - `MUSE_VOICE_TTS_MODEL` / `MUSE_VOICE_STT_MODEL` — model overrides.
 */
export function buildVoiceRegistry(env: MuseEnvironment): VoiceProviderRegistry | undefined {
  const openAiKey = env.MUSE_VOICE_OPENAI_API_KEY?.trim()
    || env.OPENAI_API_KEY?.trim();
  if (!openAiKey) {
    return undefined;
  }

  const registry = new VoiceProviderRegistry();
  registry.registerStt(
    new OpenAIWhisperSttProvider({
      apiKey: openAiKey,
      ...(env.MUSE_VOICE_STT_MODEL?.trim() ? { model: env.MUSE_VOICE_STT_MODEL.trim() } : {})
    })
  );
  registry.registerTts(
    new OpenAITtsProvider({
      apiKey: openAiKey,
      ...(env.MUSE_VOICE_TTS_MODEL?.trim() ? { model: env.MUSE_VOICE_TTS_MODEL.trim() } : {}),
      ...(env.MUSE_VOICE_TTS_VOICE?.trim() ? { defaultVoice: env.MUSE_VOICE_TTS_VOICE.trim() } : {})
    })
  );
  return registry;
}

export function ensureNotesDir(notesDir: string): void {
  try {
    mkdirSync(notesDir, { recursive: true });
  } catch {
    // Best-effort — the notes server will surface clearer errors when the
    // first list/read/save call hits a permissions issue.
  }
}


/**
 * Build the messaging provider registry from env tokens **and**
 * the persisted credential file (`~/.muse/messaging.json` or
 * `MUSE_MESSAGING_CREDENTIALS_FILE`). Env wins when both are
 * present; absence is silent. Phase 1 surface is outbound-only —
 * see `docs/design/messaging.md`.
 *
 * Recognised inputs:
 *   - MUSE_TELEGRAM_BOT_TOKEN          (env) or providers.telegram.token   (file)
 *   - MUSE_DISCORD_BOT_TOKEN           (env) or providers.discord.token    (file)
 *   - MUSE_SLACK_BOT_TOKEN  (xoxb-...) (env) or providers.slack.token      (file)
 *   - MUSE_LINE_CHANNEL_ACCESS_TOKEN   (env) or providers.line.token       (file)
 */
export function buildMessagingRegistry(env: MuseEnvironment): MessagingProviderRegistry {
  const registry = new MessagingProviderRegistry();
  const file = readCredentialsSync(resolveMessagingCredentialsFile(env));
  const tokenFor = (envKey: string, providerId: string): string | undefined => {
    const fromEnv = env[envKey]?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv;
    }
    const fromFile = stringField(file[providerId], "token");
    return fromFile && fromFile.length > 0 ? fromFile : undefined;
  };
  const telegramToken = tokenFor("MUSE_TELEGRAM_BOT_TOKEN", "telegram");
  if (telegramToken) {
    // `offsetFile` and `inboxFile` are always wired. The provider
    // only touches them on demand: `pollUpdates` reads/writes the
    // offset; `fetchInbound` reads the inbox when configured (and
    // otherwise falls through to a snapshot poll). The Phase 2.a.3
    // daemon appends new messages to the same inbox so the web
    // panel / REST converge on a single store.
    registry.register(new TelegramProvider({
      inboxFile: resolveTelegramInboxFile(env),
      offsetFile: resolveTelegramOffsetFile(env),
      token: telegramToken
    }));
  }
  const discordToken = tokenFor("MUSE_DISCORD_BOT_TOKEN", "discord");
  if (discordToken) {
    // Phase 2.c.1+2: afterFile drives pollUpdates' cursor.
    // Phase 2.c.4: inboxFile makes fetchInbound serve the
    // daemon-fed store (channel-filtered when source is given).
    // Both files are wired unconditionally; the provider only
    // touches them on demand, so an absent file is fine.
    registry.register(new DiscordProvider({
      afterFile: resolveDiscordAfterFile(env),
      inboxFile: resolveDiscordInboxFile(env),
      token: discordToken
    }));
  }
  const slackToken = tokenFor("MUSE_SLACK_BOT_TOKEN", "slack");
  if (slackToken) {
    // Phase 2.d.1+2: afterFile drives pollUpdates' per-channel ts
    // cursor. Phase 2.d.4: inboxFile makes fetchInbound serve the
    // daemon-fed store (channel-filtered when source is given).
    // Both files are wired unconditionally; the provider only
    // touches them on demand, so an absent file is fine.
    registry.register(new SlackProvider({
      afterFile: resolveSlackAfterFile(env),
      inboxFile: resolveSlackInboxFile(env),
      token: slackToken
    }));
  }
  const lineToken = tokenFor("MUSE_LINE_CHANNEL_ACCESS_TOKEN", "line");
  if (lineToken) {
    // Always pass the inbox file path; LineProvider only reads the
    // file when fetchInbound is called, so an absent file is fine.
    // The webhook handler creates it on first delivery.
    registry.register(new LineProvider({
      inboxFile: resolveLineInboxFile(env),
      token: lineToken
    }));
  }
  return registry;
}

// Suppress unused-import warning when only the type is referenced.
export type { MessagingProvider };

/**
 * Context Engineering Phase 1 — assemble a `DefaultActiveContextProvider`
 * that always carries current time + timezone, and (when user memory is
 * available) reads `working_hours` / `timezone` / `current_focus` from
 * `UserMemoryStore.preferences`. Returns `undefined` when
 * `MUSE_ACTIVE_CONTEXT_ENABLED=false`.
 */
export function buildActiveContextProvider(
  env: MuseEnvironment,
  userMemoryStore: UserMemoryStore | undefined,
  taskMemoryStore?: TaskMemoryStore,
  calendarRegistry?: CalendarProviderRegistry
): ActiveContextProvider | undefined {
  if (env.MUSE_ACTIVE_CONTEXT_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const calendarEventsResolver = calendarRegistry && env.MUSE_ACTIVE_CONTEXT_CALENDAR_ENABLED?.trim().toLowerCase() !== "false"
    ? {
        async resolve(options: { readonly nowIso: string; readonly timezone: string; readonly userId?: string }) {
          try {
            const now = new Date(options.nowIso);
            const dayStart = new Date(now);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(now);
            dayEnd.setHours(23, 59, 59, 999);
            const limit = clampPositive(env.MUSE_ACTIVE_CONTEXT_CALENDAR_LIMIT, 8);
            const events = await calendarRegistry.listEvents({ from: dayStart, to: dayEnd });
            return [...events]
              .sort((a: CalendarEvent, b: CalendarEvent) => a.startsAt.getTime() - b.startsAt.getTime())
              .slice(0, limit)
              .map((event) => ({
                allDay: event.allDay,
                endIso: event.endsAt.toISOString(),
                ...(event.location ? { location: event.location } : {}),
                startIso: event.startsAt.toISOString(),
                title: event.title
              }));
          } catch {
            return undefined;
          }
        }
      }
    : undefined;
  const activeTaskResolver = taskMemoryStore
    ? {
        async resolve(options: { readonly userId?: string; readonly sessionId?: string }) {
          const { sessionId, userId } = options;
          if (!sessionId) {
            return undefined;
          }
          try {
            const state = await taskMemoryStore.findActiveBySession(sessionId, userId);
            if (!state) {
              return undefined;
            }
            return {
              id: state.taskId,
              ...(state.metadata?.dueIso ? { dueIso: state.metadata.dueIso } : {}),
              title: state.goal
            };
          } catch {
            return undefined;
          }
        }
      }
    : undefined;
  // Iter 41: read pending reminders from the local store and feed
  // them into [Active Context] so the agent can say "you asked me
  // to remind you about X at 3 — it's 2:55" without an extra tool
  // call. Opt-out via `MUSE_ACTIVE_CONTEXT_REMINDERS_ENABLED=false`.
  const remindersResolver: RemindersResolver | undefined =
    env.MUSE_ACTIVE_CONTEXT_REMINDERS_ENABLED?.trim().toLowerCase() === "false"
      ? undefined
      : {
        async resolve(): Promise<readonly ReminderHint[] | undefined> {
          try {
            const reminders = await readReminders(resolveRemindersFile(env));
            return reminders
              .filter((reminder) => reminder.status === "pending")
              .map((reminder) => ({ dueIso: reminder.dueAt, text: reminder.text }));
          } catch {
            return undefined;
          }
        }
      };
  return new DefaultActiveContextProvider({
    ...(activeTaskResolver ? { activeTaskResolver } : {}),
    ...(calendarEventsResolver ? { calendarEventsResolver } : {}),
    ...(env.MUSE_DEFAULT_TIMEZONE?.trim() ? { defaultTimezone: env.MUSE_DEFAULT_TIMEZONE.trim() } : {}),
    ...(remindersResolver ? { remindersResolver } : {}),
    ...(userMemoryStore ? { userMemoryProvider: userMemoryStore } : {})
  });
}

/**
 * Context Engineering Phase 2 — build a `FileBackedInboxContextProvider`
 * over every messaging provider that has a registered token. Each
 * provider gets its own cursor file under `~/.muse/{id}-inbox-injection.json`
 * (overrideable via `MUSE_{ID}_INBOX_INJECTION_CURSOR_FILE`). Returns
 * `undefined` when no messaging provider is configured OR when
 * `MUSE_INBOX_CONTEXT_ENABLED=false`.
 */
export function buildInboxContextProvider(env: MuseEnvironment): InboxContextProvider | undefined {
  if (env.MUSE_INBOX_CONTEXT_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const sources: InboxSourceConfig[] = [];
  const credentials = readCredentialsSync(resolveMessagingCredentialsFile(env));
  const hasToken = (envKey: string, providerId: string): boolean => {
    const fromEnv = env[envKey]?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return true;
    }
    const fromFile = stringField(credentials[providerId], "token");
    return Boolean(fromFile && fromFile.length > 0);
  };
  if (hasToken("MUSE_TELEGRAM_BOT_TOKEN", "telegram")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "telegram"),
      inboxFile: resolveTelegramInboxFile(env),
      providerId: "telegram"
    });
  }
  if (hasToken("MUSE_DISCORD_BOT_TOKEN", "discord")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "discord"),
      inboxFile: resolveDiscordInboxFile(env),
      providerId: "discord"
    });
  }
  if (hasToken("MUSE_SLACK_BOT_TOKEN", "slack")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "slack"),
      inboxFile: resolveSlackInboxFile(env),
      providerId: "slack"
    });
  }
  if (hasToken("MUSE_LINE_CHANNEL_ACCESS_TOKEN", "line")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "line"),
      inboxFile: resolveLineInboxFile(env),
      providerId: "line"
    });
  }
  if (sources.length === 0) {
    return undefined;
  }
  const perProviderLimit = clampPositive(env.MUSE_INBOX_INJECT_LIMIT, 20);
  const totalLimit = clampPositive(env.MUSE_INBOX_INJECT_TOTAL_LIMIT, 80);
  return new FileBackedInboxContextProvider({ perProviderLimit, sources, totalLimit });
}

/**
 * Context Engineering Phase 3 — build a `StoreBackedEpisodicRecallProvider`
 * over the persisted conversation-summary store. Returns `undefined`
 * when `MUSE_EPISODIC_RECALL_ENABLED=false` or when no store is
 * available. Jaccard token-overlap recall — no embeddings, no
 * pgvector. Default on so newly-shipped users get cross-session
 * memory the moment their first session compacts.
 */
export function buildEpisodicRecallProvider(
  env: MuseEnvironment,
  summaryStore: ConversationSummaryStore | undefined
): EpisodicRecallProvider | undefined {
  if (env.MUSE_EPISODIC_RECALL_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  if (!summaryStore || typeof summaryStore.listAll !== "function") {
    return undefined;
  }
  const topK = clampPositive(env.MUSE_EPISODIC_RECALL_TOPK, 3);
  const maxFetched = clampPositive(env.MUSE_EPISODIC_RECALL_MAX_FETCHED, 200);
  const minScoreRaw = env.MUSE_EPISODIC_RECALL_MIN_SCORE?.trim();
  const minScoreParsed = minScoreRaw ? Number.parseFloat(minScoreRaw) : Number.NaN;
  const minScore = Number.isFinite(minScoreParsed) && minScoreParsed >= 0
    ? minScoreParsed
    : 0.15;
  return new StoreBackedEpisodicRecallProvider({
    maxFetched,
    minScore,
    store: summaryStore,
    topK
  });
}

/**
 * Context Engineering Phase 4 — opt-in `DefaultToolFilter` controlled
 * by `MUSE_TOOL_FILTER_ENABLED=true`. Default off so existing setups
 * see no behavioural change.
 */
export function buildToolFilter(env: MuseEnvironment): ToolFilter | undefined {
  if (env.MUSE_TOOL_FILTER_ENABLED?.trim().toLowerCase() !== "true") {
    return undefined;
  }
  return new DefaultToolFilter();
}

/**
 * In-process telemetry aggregator (iter 38 — wiring the surface
 * iters 8 / 17 / 26 / 37 built but never instantiated in
 * production). Default ON; `MUSE_TELEMETRY_AGGREGATOR_ENABLED=false`
 * skips construction (returns undefined → AgentRuntime no-ops the
 * `recordTelemetry` call so per-run telemetry is free of overhead).
 *
 * The aggregator is in-process and bounded by `capacity` (default
 * 10k events ~= a week of moderate use); restart wipes state. A
 * durable Kysely-backed sink can layer on later — every consumer
 * accesses the same `TelemetryAggregator` interface.
 */
export function buildTelemetryAggregator(env: MuseEnvironment): TelemetryAggregator | undefined {
  if (env.MUSE_TELEMETRY_AGGREGATOR_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const capacityRaw = env.MUSE_TELEMETRY_AGGREGATOR_CAPACITY?.trim();
  const capacity = capacityRaw && /^\d+$/u.test(capacityRaw)
    ? Number.parseInt(capacityRaw, 10)
    : undefined;
  return new InMemoryTelemetryAggregator(capacity !== undefined ? { capacity } : {});
}

/**
 * Build the SKILL.md registry by scanning user + workspace dirs.
 * Loads asynchronously off the hot path of
 * `createMuseRuntimeAssembly` — callers `await` the promise once
 * during boot to pre-warm the registry before serving traffic.
 *
 * Roots in low → high precedence:
 *   1. user dir (`~/.muse/skills/`)
 *   2. workspace dir (`MUSE_WORKSPACE_SKILLS_DIR`)
 *
 * Returns `undefined` when `MUSE_SKILLS_ENABLED=false`.
 */
export async function buildSkillRegistry(env: MuseEnvironment): Promise<SkillRegistry | undefined> {
  if (env.MUSE_SKILLS_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const roots: { path: string; source: "user" | "workspace" }[] = [
    { path: resolveUserSkillsDir(env), source: "user" }
  ];
  const workspace = resolveWorkspaceSkillsDir(env);
  if (workspace) {
    roots.push({ path: workspace, source: "workspace" });
  }
  const loader = new FileSystemSkillLoader({ roots });
  const skills = await loader.loadAll();
  return new InMemorySkillRegistry(skills);
}

/**
 * Wrap a `SkillRegistry` (sync) OR a pending `Promise<SkillRegistry>`
 * (from the async loader) as a `SkillCatalogProvider`. The catalog
 * provider's `list()` is async-friendly so the autoconfigure caller
 * can stay synchronous while the disk scan finishes — the first
 * request just `await`s the registry promise and subsequent calls
 * are O(1).
 */
export function buildSkillCatalogProvider(
  registryOrPromise: SkillRegistry | Promise<SkillRegistry | undefined> | undefined
): SkillCatalogProvider | undefined {
  if (!registryOrPromise) {
    return undefined;
  }
  return {
    async list(): Promise<readonly SkillCatalogEntry[]> {
      const registry = await registryOrPromise;
      return registry ? registry.list().map(toCatalogEntry) : [];
    }
  };
}

function toCatalogEntry(skill: Skill): SkillCatalogEntry {
  return {
    ...(skill.frontmatter.emoji ? { emoji: skill.frontmatter.emoji } : {}),
    description: skill.description,
    name: skill.name,
    ...(skill.frontmatter.requires?.bins && skill.frontmatter.requires.bins.length > 0
      ? { requiresBins: [...skill.frontmatter.requires.bins] }
      : {}),
    // iter 45: any-of CLI requirement (e.g. "codex OR claude")
    // forwarded so the agent can see the alternate-CLI dependency
    // in `[Available Skills]` and route accordingly.
    ...(skill.frontmatter.requires?.anyBins && skill.frontmatter.requires.anyBins.length > 0
      ? { requiresAnyBins: [...skill.frontmatter.requires.anyBins] }
      : {})
  };
}

