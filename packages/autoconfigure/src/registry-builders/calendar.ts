/**
 * Calendar-registry builder — env + ~/.muse/calendar-credentials.json
 * → `CalendarProviderRegistry` with the personal-JARVIS subset
 * (local / gcal / caldav / macos). Lifted from
 * `personal-providers.ts` following the same pattern as the
 * messaging builder, so the registry-builders folder stays the
 * natural home for these env → registry constructors.
 */

import { existsSync } from "node:fs";

import {
  CalDAVCalendarProvider,
  CalendarProviderRegistry,
  GoogleCalendarProvider,
  LocalCalendarProvider,
  LocalIcsCalendarProvider,
  MacOsCalendarProvider,
  type CalendarProvider
} from "@muse/calendar";

import type { MuseEnvironment } from "../index.js";
import { resolveCalendarIcsFile, resolveCredentialsFile, resolveLocalCalendarFile } from "../provider-paths.js";
import { readCredentialsSync, stringField } from "../provider-utils.js";

export function buildCalendarRegistry(env: MuseEnvironment): CalendarProviderRegistry {
  const registry = new CalendarProviderRegistry();
  const requested = (env.MUSE_CALENDAR_PROVIDERS?.trim() || "local")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  // Zero-config discovery: if the user just drops an exported calendar at
  // `~/.muse/calendar.ics` (or MUSE_CALENDAR_ICS_FILE), read it WITHOUT having
  // to set MUSE_CALENDAR_PROVIDERS — same "it just works" as the notes corpus.
  // Read-only + local, so auto-enabling is safe.
  if (!requested.includes("ics") && existsSync(resolveCalendarIcsFile(env))) {
    requested.push("ics");
  }
  const credentials = readCredentialsSync(resolveCredentialsFile(env), env);

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

  if (id === "ics") {
    // Read-only LOCAL .ics file — a user's exported calendar, no cloud.
    return new LocalIcsCalendarProvider({ file: resolveCalendarIcsFile(env) });
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
