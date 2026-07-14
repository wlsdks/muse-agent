/**
 * "Does the user have personal data to ground on?" — the store-presence checks the
 * `muse ask` empty-notes on-ramp uses to avoid nagging a user who has clearly set
 * Muse up (remembered facts, contacts, tasks, reminders, past sessions) but happens
 * to have no NOTES. Lifted out of the commands-ask god-file. Each store read is
 * best-effort (a missing/unreadable store counts as empty) and short-circuits on the
 * first hit.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveContactsFile, resolveEpisodesFile, resolveRemindersFile, resolveTasksFile, type MuseEnvironment } from "@muse/autoconfigure";
import { readContacts, readEpisodes, readReminders, readTasks } from "@muse/stores";

/** Whether the persistent user-memory file holds any fact/preference for `userId`. */
async function userMemoryHasFacts(userId: string, env: MuseEnvironment): Promise<boolean> {
  try {
    const file = env.MUSE_USER_MEMORY_FILE?.trim() || join(homedir(), ".muse", "user-memory.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as { users?: Record<string, { facts?: Record<string, string>; preferences?: Record<string, string> }> };
    const persona = raw.users?.[userId];
    return Boolean(persona && (Object.keys(persona.facts ?? {}).length > 0 || Object.keys(persona.preferences ?? {}).length > 0));
  } catch {
    return false;
  }
}

/**
 * Whether the user has ANY personal data Muse can ground on besides notes —
 * remembered facts/preferences, contacts, open tasks, reminders, or past sessions.
 * Used to suppress the empty-notes on-ramp for a user who has clearly set Muse up
 * with other data. Best-effort per store; short-circuits on the first hit.
 */
export async function userHasOtherPersonalData(
  userId: string,
  env: MuseEnvironment
): Promise<boolean> {
  if (await userMemoryHasFacts(userId, env)) return true;
  try {
    if ((await readContacts(resolveContactsFile(env))).length > 0) return true;
  } catch { /* skip */ }
  try {
    if ((await readTasks(resolveTasksFile(env))).length > 0) return true;
  } catch { /* skip */ }
  try {
    if ((await readReminders(resolveRemindersFile(env))).length > 0) return true;
  } catch { /* skip */ }
  try {
    // A continuous-companion user with past sessions (but no notes) isn't "empty".
    if ((await readEpisodes(resolveEpisodesFile(env))).some((e) => e.userId === userId)) return true;
  } catch { /* skip */ }
  return false;
}
