/**
 * Bulk READ of the user's Apple Contacts.app address book, for the
 * `muse contacts import --apple` command. This is the ingestion that stops the
 * already-built birthday / relationship / recipient-resolution features from
 * starving an empty local people graph.
 *
 * Read-only: one osascript pass emits EVERY person as a delimited payload this
 * module parses into store-ready records. No contact text is ever interpolated
 * INTO the AppleScript (the whole address book is iterated, not queried by a
 * name substring), so there is no AppleScript-injection surface — a person
 * literally named `"; end tell` is just a name.
 *
 * Payload robustness. Fields are separated by C0 control chars — RECORD 0x1e /
 * FIELD 0x1f / VALUE 0x1d — chosen because they cannot occur in a Contacts
 * field value: no Apple UI lets you type a raw C0 control, and vCard/CardDAV
 * cannot carry one either. Commas, quotes, tabs, newlines, Korean, emoji in a
 * name all survive intact (they are none of these delimiters). Every parsed
 * value is additionally run through `stripUntrustedTerminalChars`, so any
 * residual control byte a contact somehow smuggled in is removed before the
 * value reaches the store or the terminal.
 *
 * Fail-soft: no permission (-1743), a wedged Contacts, or a missing osascript
 * returns `{ ok: false, error }` — never throws, so the caller leaves the store
 * untouched.
 */

import { stripUntrustedTerminalChars } from "@muse/shared";

import {
  defaultOsascriptRunner,
  isPermissionError,
  OSASCRIPT_TIMEOUT_MS,
  type MacCommandResult,
  type MacOsascriptRunner
} from "./macos-exec.js";

/** One person read out of Contacts.app, mapped to the fields Muse's store uses. */
export interface AppleContact {
  readonly name: string;
  readonly organization?: string;
  /** All phone values, in Contacts order; verbatim (not reformatted). */
  readonly phones: readonly string[];
  /** All email values, in Contacts order, lower-cased on dedup downstream. */
  readonly emails: readonly string[];
  /** `MM-DD` (year-less Contacts birthday) or `YYYY-MM-DD`, matching the store. */
  readonly birthday?: string;
}

export interface ReadAppleContactsResult {
  readonly ok: boolean;
  readonly contacts: readonly AppleContact[];
  /** Present only when `ok` is false — an actionable, already-truncated message. */
  readonly error?: string;
}

/**
 * Reading the whole address book in one osascript pass can be slow on a large
 * book; the cap bounds the worst case (and a runaway store). 2000 covers the
 * overwhelming majority of personal address books.
 */
export const APPLE_CONTACTS_IMPORT_CAP = 2000;

const RECORD_SEP = "\x1E";
const FIELD_SEP = "\x1F";
const VALUE_SEP = "\x1D";

/**
 * A Contacts birthday whose YEAR is unset comes back through AppleScript with a
 * sentinel year (historically 1604). Any year below this floor is treated as
 * "no year" and mapped to `MM-DD`; a real year maps to `YYYY-MM-DD`. Both shapes
 * are what `resolveUpcomingBirthdays` consumes.
 */
const BIRTHDAY_NO_YEAR_FLOOR = 1900;

/** The one AppleScript that emits the entire (capped) address book as a delimited payload. */
export function buildReadAppleContactsScript(cap: number = APPLE_CONTACTS_IMPORT_CAP): string {
  return [
    `set recSep to (character id 30)`,
    `set fldSep to (character id 31)`,
    `set valSep to (character id 29)`,
    `set maxN to ${Math.max(0, Math.trunc(cap)).toString()}`,
    `set output to ""`,
    `tell application "Contacts"`,
    `  set ppl to people`,
    `  set total to count of ppl`,
    `  if total > maxN then set total to maxN`,
    `  repeat with i from 1 to total`,
    `    set p to item i of ppl`,
    `    set nm to ""`,
    `    try`,
    `      set nm to (name of p) as text`,
    `    end try`,
    `    set org to ""`,
    `    try`,
    `      set og to organization of p`,
    `      if og is not missing value then set org to og as text`,
    `    end try`,
    `    set bd to ""`,
    `    try`,
    `      set b to birth date of p`,
    `      if b is not missing value then`,
    `        set bd to ((year of b) as text) & "-" & (((month of b) as integer) as text) & "-" & ((day of b) as text)`,
    `      end if`,
    `    end try`,
    `    set phs to ""`,
    `    try`,
    `      repeat with ph in phones of p`,
    `        set phs to phs & (value of ph) & valSep`,
    `      end repeat`,
    `    end try`,
    `    set ems to ""`,
    `    try`,
    `      repeat with em in emails of p`,
    `        set ems to ems & (value of em) & valSep`,
    `      end repeat`,
    `    end try`,
    `    set output to output & nm & fldSep & org & fldSep & bd & fldSep & phs & fldSep & ems & recSep`,
    `  end repeat`,
    `end tell`,
    `return output`
  ].join("\n");
}

/** Trim + strip any residual C0/C1 control chars from a parsed value. */
function clean(value: string): string {
  return stripUntrustedTerminalChars(value).trim();
}

/** Split a VALUE_SEP-joined multi-value field into cleaned, de-duplicated, non-empty entries. */
function splitMulti(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(VALUE_SEP)) {
    const v = clean(part);
    if (v.length === 0 || seen.has(v)) {
      continue;
    }
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Map the AppleScript `Y-M-D` (unpadded) birthday to the store's `MM-DD` / `YYYY-MM-DD`. */
export function normalizeAppleBirthday(raw: string): string | undefined {
  const m = /^(-?\d+)-(\d+)-(\d+)$/u.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(month) || !Number.isFinite(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  if (!Number.isFinite(year) || year < BIRTHDAY_NO_YEAR_FLOOR) {
    return `${mm}-${dd}`;
  }
  return `${String(year).padStart(4, "0")}-${mm}-${dd}`;
}

/** Parse the delimited osascript payload into store-ready Apple contacts. Never throws. */
export function parseAppleContactsPayload(stdout: string): AppleContact[] {
  const out: AppleContact[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    if (record.length === 0) {
      continue;
    }
    const fields = record.split(FIELD_SEP);
    const name = clean(fields[0] ?? "");
    if (name.length === 0) {
      continue;
    }
    const organization = clean(fields[1] ?? "");
    const birthday = normalizeAppleBirthday(fields[2] ?? "");
    out.push({
      name,
      phones: splitMulti(fields[3] ?? ""),
      emails: splitMulti(fields[4] ?? ""),
      ...(organization.length > 0 ? { organization } : {}),
      ...(birthday !== undefined ? { birthday } : {})
    });
  }
  return out;
}

const errMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Read the whole Apple Contacts address book via one osascript pass. Fail-soft:
 * a permission denial, timeout, spawn failure, or non-zero exit all return
 * `{ ok: false, error }` (never throw) so the import command leaves the local
 * store byte-identical.
 */
export async function readAppleContacts(
  exec: MacOsascriptRunner = defaultOsascriptRunner,
  cap: number = APPLE_CONTACTS_IMPORT_CAP
): Promise<ReadAppleContactsResult> {
  let result: MacCommandResult;
  try {
    result = await exec(buildReadAppleContactsScript(cap));
  } catch (cause) {
    return { ok: false, contacts: [], error: `osascript spawn failed: ${errMessage(cause)}` };
  }
  if (result.timedOut) {
    return {
      ok: false,
      contacts: [],
      error: `reading Contacts timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms (an unanswered Automation permission prompt?)`
    };
  }
  if (result.exitCode !== 0) {
    if (isPermissionError(result.stderr)) {
      return {
        ok: false,
        contacts: [],
        error:
          "Contacts access denied — grant it in System Settings → Privacy & Security → Automation (allow your terminal to control Contacts), then retry."
      };
    }
    return { ok: false, contacts: [], error: `reading Contacts failed: ${result.stderr.trim().slice(0, 300) || "osascript error"}` };
  }
  return { ok: true, contacts: parseAppleContactsPayload(result.stdout) };
}
