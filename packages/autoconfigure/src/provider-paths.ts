import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import type { MuseEnvironment } from "./index.js";

/**
 * Every personal-providers path resolver shares the same shape:
 * trim the env override, fall back to a default under `~/.muse/`.
 * Encoding it once keeps each resolver a one-liner and stops
 * copy-paste drift when a new data file joins the set.
 */
function resolveDotMusePath(env: MuseEnvironment, envKey: string, defaultName: string): string {
  const override = env[envKey]?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", defaultName);
}

export function resolveNotesDir(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_NOTES_DIR", "notes");
}

export function resolveCredentialsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CREDENTIALS_FILE", "credentials.json");
}

export function resolveLocalCalendarFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CALENDAR_FILE", "calendar.json");
}

export function resolveTasksFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_TASKS_FILE", "tasks.json");
}

export function resolveMessagingCredentialsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_MESSAGING_CREDENTIALS_FILE", "messaging.json");
}

export function resolveRemindersFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_REMINDERS_FILE", "reminders.json");
}

export function resolveReminderHistoryFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_REMINDER_HISTORY_FILE", "reminder-history.json");
}

export function resolveProactiveHistoryFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json");
}

export function resolveFollowupsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_FOLLOWUPS_FILE", "followups.json");
}

export function resolveLineInboxFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_LINE_INBOX_FILE", "line-inbox.json");
}

export function resolveTelegramOffsetFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_TELEGRAM_OFFSET_FILE", "telegram-offset.json");
}

export function resolveTelegramInboxFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_TELEGRAM_INBOX_FILE", "telegram-inbox.json");
}

export function resolveDiscordAfterFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_DISCORD_AFTER_FILE", "discord-after.json");
}

export function resolveDiscordInboxFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_DISCORD_INBOX_FILE", "discord-inbox.json");
}

export function resolveSlackAfterFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_SLACK_AFTER_FILE", "slack-after.json");
}

export function resolveSlackInboxFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_SLACK_INBOX_FILE", "slack-inbox.json");
}

export function resolveUserSkillsDir(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_SKILLS_DIR", "skills");
}

export function resolveWorkspaceSkillsDir(env: MuseEnvironment): string | undefined {
  const override = env.MUSE_WORKSPACE_SKILLS_DIR?.trim();
  return override && override.length > 0 ? override : undefined;
}

export function resolveInboxInjectionCursorFile(env: MuseEnvironment, providerId: string): string {
  return resolveDotMusePath(
    env,
    `MUSE_${providerId.toUpperCase()}_INBOX_INJECTION_CURSOR_FILE`,
    `${providerId}-inbox-injection.json`
  );
}

export function resolveModelKeysFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_MODEL_KEYS_FILE", "models.json");
}
