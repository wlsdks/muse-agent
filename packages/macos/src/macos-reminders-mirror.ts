/**
 * One-way mirror of a Muse-created reminder into Apple Reminders.app so it
 * shows up on the user's iPhone / Apple Watch. Muse's own store stays the
 * source of truth (the proactive loops keep reading it); Apple gets a
 * best-effort, create-only copy.
 *
 * Opt-in and fail-soft by construction:
 *   - `MUSE_APPLE_REMINDERS_MIRROR` (parseBoolean, default OFF) gates every
 *     osascript call. Absent/false ⇒ ZERO exec, behaviour byte-identical to a
 *     build without this module.
 *   - Create-only: a Muse reminder CREATE maps to one `make new reminder`.
 *     Completing / deleting / snoozing in Muse does NOT sync — see the env
 *     var description in docs.
 *   - A mirror failure (osascript error, missing Automation permission,
 *     timeout) NEVER throws — it returns a `warning` the caller surfaces. The
 *     Muse write must never roll back because Apple was unreachable.
 *
 * Injection safety: the reminder title is user/model-controlled text going
 * into an AppleScript program. It is escaped with the package's shared
 * {@link escapeAppleScript} (the same helper the iMessage / app-read tools
 * use) so a hostile title cannot terminate the string context and inject
 * statements. The due date is passed as an integer epoch to `date -r`, never
 * as interpolated text.
 */

import {
  defaultOsascriptRunner,
  escapeAppleScript,
  type MacOsascriptRunner
} from "./macos-exec.js";
import { isMirrorEnvEnabled, runMirrorScript } from "./mirror-shared.js";

export const APPLE_REMINDERS_MIRROR_ENV = "MUSE_APPLE_REMINDERS_MIRROR";

export interface MirrorableReminder {
  readonly text: string;
  /** ISO-8601 due timestamp. Omitted / blank / unparseable ⇒ no due date set. */
  readonly dueAt?: string;
}

export interface MirrorReminderOptions {
  /** Environment to read the opt-in switch from. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** osascript runner (injected in tests). Defaults to the real spawn. */
  readonly exec?: MacOsascriptRunner;
  /** Optional Reminders.app list name. Omitted ⇒ the default list. */
  readonly list?: string;
}

export interface MirrorReminderResult {
  /** True only when Reminders.app confirmed the create (exit 0). */
  readonly mirrored: boolean;
  /** True when the opt-in switch is off — no osascript was spawned. */
  readonly skipped: boolean;
  /** Fail-soft, human-readable reason the mirror did not land. Never thrown. */
  readonly warning?: string;
  /** The generated AppleScript (present whenever a script was built). */
  readonly script?: string;
}

/** Whether the Apple-Reminders mirror is opted in via `MUSE_APPLE_REMINDERS_MIRROR`. */
export function isAppleRemindersMirrorEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isMirrorEnvEnabled(env, APPLE_REMINDERS_MIRROR_ENV);
}

/**
 * Build the `make new reminder` AppleScript for one reminder. The title (and
 * list name) are escaped; the due date, when present and parseable, is emitted
 * as a `remind me date` sourced from an integer epoch via `date -r` — the
 * timezone-correct counterpart of MacOsCalendarProvider.createEvent's
 * `%Y-%m-%d %H:%M:%S`-then-`as date` shape (a real UTC instant renders to the
 * machine's LOCAL wall clock, so a KST due time lands at the right hour).
 */
export function buildMirrorReminderScript(reminder: MirrorableReminder, list?: string): string {
  const name = escapeAppleScript(reminder.text);
  const note = escapeAppleScript("from Muse");
  const properties = [`name:"${name}"`, `body:"${note}"`];

  const dueMs = reminder.dueAt ? Date.parse(reminder.dueAt) : Number.NaN;
  let dateSetup = "";
  if (Number.isFinite(dueMs)) {
    const epochSeconds = Math.floor(dueMs / 1000);
    dateSetup = `set dueDate to (do shell script "date -r ${epochSeconds.toString()} '+%Y-%m-%d %H:%M:%S'") as date\n`;
    properties.push("remind me date:dueDate");
  }

  const listClause = list && list.trim().length > 0
    ? ` in list "${escapeAppleScript(list)}"`
    : "";

  return (
    `${dateSetup}tell application "Reminders"\n`
    + `  make new reminder${listClause} with properties {${properties.join(", ")}}\n`
    + `end tell`
  );
}

/**
 * Mirror one newly-created Muse reminder into Apple Reminders.app. Never
 * throws: returns `{ skipped: true }` when the opt-in switch is off (zero
 * exec), `{ mirrored: true }` on a confirmed create, or `{ warning }` on any
 * failure so the caller can surface it without failing the Muse write.
 */
export async function mirrorReminderToApple(
  reminder: MirrorableReminder,
  options: MirrorReminderOptions = {}
): Promise<MirrorReminderResult> {
  const env = options.env ?? process.env;
  if (!isAppleRemindersMirrorEnabled(env)) {
    return { mirrored: false, skipped: true };
  }
  const text = reminder.text.trim();
  if (text.length === 0) {
    return { mirrored: false, skipped: false, warning: "Apple Reminders mirror skipped: empty reminder text" };
  }
  const exec = options.exec ?? defaultOsascriptRunner;
  const script = buildMirrorReminderScript({ text, dueAt: reminder.dueAt }, options.list);
  const outcome = await runMirrorScript(exec, script, { app: "Apple Reminders", permissionTarget: "Reminders" });
  return { mirrored: outcome.mirrored, skipped: false, warning: outcome.warning, script };
}
