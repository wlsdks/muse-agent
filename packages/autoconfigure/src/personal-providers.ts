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

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  CalDAVCalendarProvider,
  CalendarProviderRegistry,
  GoogleCalendarProvider,
  LocalCalendarProvider,
  MacOsCalendarProvider,
  type CalendarProvider
} from "@muse/calendar";
import {
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  VoiceProviderRegistry
} from "@muse/voice";

import type { MuseEnvironment } from "./index.js";

export function resolveNotesDir(env: MuseEnvironment): string {
  const override = env.MUSE_NOTES_DIR?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", "notes");
}

export function resolveCredentialsFile(env: MuseEnvironment): string {
  const override = env.MUSE_CREDENTIALS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", "credentials.json");
}

export function resolveLocalCalendarFile(env: MuseEnvironment): string {
  const override = env.MUSE_CALENDAR_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", "calendar.json");
}

export function resolveTasksFile(env: MuseEnvironment): string {
  const override = env.MUSE_TASKS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", "tasks.json");
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

function readCredentialsSync(file: string): Record<string, Record<string, unknown>> {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { readonly providers?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
      return {};
    }
    return { ...(parsed.providers as Record<string, Record<string, unknown>>) };
  } catch {
    return {};
  }
}

function stringField(record: { readonly [key: string]: unknown } | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
