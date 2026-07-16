/**
 * macOS Reminders.app adapter via AppleScript (osascript) — mirrors
 * the `AppleNotesProvider` pattern for the tasks domain.
 *
 * Uses tab-separated AppleScript output so titles + bodies (which can
 * contain commas, newlines, parentheses) never have to be parsed
 * out of free-form text. Each operation pipes a generated `tell
 * application "Reminders" ...` snippet into `osascript -` and parses
 * the structured stdout.
 *
 * Permissions: the first call triggers the system "Allow Reminders
 * access" prompt. Until granted, every script fails — we map that to
 * a typed `REMINDERS_PERMISSION` error so a CLI wizard can guide the
 * user through System Settings → Privacy & Security → Automation.
 *
 * Status mapping:
 *   - Reminders.app exposes a `completed` boolean on each reminder.
 *   - Our `Task.status: "open" | "done"` maps cleanly to
 *     `completed=false` / `completed=true`.
 *   - `complete(id)` sets `completed` to true; the `completion date`
 *     property gets stamped automatically by Reminders.app.
 *   - Listing with `status="open"` filters by `completed is false`;
 *     `"done"` filters by `completed is true`; `"all"` returns every
 *     reminder regardless.
 *
 * `notes` and `tags` are limited:
 *   - `notes` round-trips through Reminders.app's body field.
 *   - `tags` are not native to Reminders before macOS 13 and the
 *     AppleScript surface for them is unreliable across versions —
 *     this provider drops the tags input on `add` and never returns
 *     tags in `list`. Future iter could add tag support behind an
 *     opt-in flag once macOS Sonoma+ AppleScript surface is stable.
 */

import { runCommandWithTimeout } from "@muse/shared";

import { normalizeAppleScriptTimeout, quoteAppleScriptString as quote } from "./apple-script-shared.js";

import {
  TasksProviderError,
  TasksValidationError,
  type Task,
  type TaskInput,
  type TaskSearchHit,
  type TasksProvider,
  type TasksProviderInfo
} from "./tasks-providers.js";

export interface AppleRemindersProviderOptions {
  /**
   * Reminders.app list name to scope reads / writes against. When
   * omitted, the adapter operates against every list (read/search)
   * and saves into the default list (typically named "Reminders").
   */
  readonly list?: string;
  /**
   * `osascript` binary path. Defaults to `/usr/bin/osascript`.
   * Override in tests with a stub that produces canned output.
   */
  readonly osascriptPath?: string;
  /** osascript watchdog timeout (ms). Defaults to 30_000. */
  readonly timeoutMs?: number;
}

export class AppleRemindersProvider implements TasksProvider {
  readonly id = "apple-reminders";
  private readonly listName?: string;
  private readonly osascriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: AppleRemindersProviderOptions = {}) {
    this.listName = options.list;
    this.osascriptPath = options.osascriptPath ?? "/usr/bin/osascript";
    this.timeoutMs = normalizeAppleScriptTimeout(options.timeoutMs);
  }

  describe(): TasksProviderInfo {
    return {
      description: this.listName
        ? `Apple Reminders via AppleScript (list: ${this.listName}).`
        : "Apple Reminders via AppleScript (default list).",
      displayName: "Apple Reminders",
      id: this.id,
      local: true
    };
  }

  async list(status: "open" | "done" | "all" = "open"): Promise<readonly Task[]> {
    const filter = status === "open"
      ? "whose completed is false"
      : status === "done"
        ? "whose completed is true"
        : "";
    const target = this.listName
      ? `every reminder of list ${quote(this.listName)} ${filter}`
      : `every reminder ${filter}`;
    const script = `
      set output to ""
      tell application "Reminders"
        repeat with r in (${target})
          set rid to (id of r as string)
          set rname to (name of r as string)
          set rcompleted to (completed of r as boolean)
          set rcreated to (creation date of r)
          set rcompletion to ""
          if rcompleted then
            try
              set rcompletion to ((completion date of r) as «class isot» as string)
            end try
          end if
          set rbody to ""
          try
            set rbody to (body of r as string)
          end try
          set output to output & rid & tab & rname & tab & (rcreated as «class isot» as string) & tab & (rcompleted as string) & tab & rcompletion & tab & rbody & linefeed
        end repeat
      end tell
      return output
    `;
    const stdout = await this.runScript(script);
    return parseListOutput(stdout, this.id);
  }

  async add(input: TaskInput): Promise<Task> {
    const title = input.title?.trim();
    if (!title) {
      throw new TasksValidationError("EMPTY_TITLE", "TaskInput.title must not be empty");
    }
    const listClause = this.listName ? ` in list ${quote(this.listName)}` : "";
    const propertyParts = [`name:${quote(title)}`];
    if (input.notes) {
      propertyParts.push(`body:${quote(input.notes)}`);
    }
    const script = `
      tell application "Reminders"
        set newReminder to make new reminder${listClause} with properties {${propertyParts.join(", ")}}
        set rid to (id of newReminder as string)
        set rcreated to ((creation date of newReminder) as «class isot» as string)
        return rid & tab & rcreated
      end tell
    `;
    const stdout = (await this.runScript(script)).trim();
    const [id, createdIso] = stdout.split("\t");
    if (!id) {
      throw new TasksProviderError(this.id, "BAD_RESPONSE", `Reminders.app did not return an id: ${stdout}`);
    }
    return {
      createdAt: toDateOrNow(createdIso),
      id,
      providerId: this.id,
      status: "open",
      title,
      ...(input.notes ? { notes: input.notes } : {})
      // tags intentionally dropped — see file header for rationale.
    };
  }

  async complete(id: string): Promise<Task | undefined> {
    if (!id || id.trim().length === 0) {
      throw new TasksValidationError("EMPTY_ID", "AppleRemindersProvider.complete requires a non-empty id");
    }
    const script = `
      tell application "Reminders"
        set matches to (every reminder whose id is ${quote(id)})
        if (count of matches) is 0 then
          return ""
        end if
        set r to first item of matches
        if completed of r is false then
          set completed of r to true
        end if
        set rname to (name of r as string)
        set rcreated to ((creation date of r) as «class isot» as string)
        set rcompletion to ""
        try
          set rcompletion to ((completion date of r) as «class isot» as string)
        end try
        set rbody to ""
        try
          set rbody to (body of r as string)
        end try
        return rname & tab & rcreated & tab & rcompletion & tab & rbody
      end tell
    `;
    const stdout = (await this.runScript(script)).trim();
    if (stdout.length === 0) {
      return undefined;
    }
    const [title = "", createdIso = "", completionIso = "", body = ""] = stdout.split("\t");
    return {
      createdAt: toDateOrNow(createdIso),
      id,
      providerId: this.id,
      status: "done",
      title,
      ...(completionIso ? { completedAt: toDateOrNow(completionIso) } : {}),
      ...(body ? { notes: body } : {})
    };
  }

  async search(query: string, limit: number): Promise<readonly TaskSearchHit[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) {
      throw new TasksValidationError("EMPTY_QUERY", "AppleRemindersProvider.search requires a non-empty query");
    }
    const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 20));
    // Reminders.app's `whose name contains X or body contains X` works
    // via AppleScript. Note that `body` may not always exist on a
    // reminder — the `try` blocks in `list` handle that gracefully.
    const target = this.listName
      ? `every reminder of list ${quote(this.listName)} whose name contains ${quote(trimmed)} or body contains ${quote(trimmed)}`
      : `every reminder whose name contains ${quote(trimmed)} or body contains ${quote(trimmed)}`;
    const script = `
      set output to ""
      set hitCount to 0
      tell application "Reminders"
        repeat with r in (${target})
          if hitCount >= ${cap} then exit repeat
          set rid to (id of r as string)
          set rname to (name of r as string)
          set rcompleted to (completed of r as boolean)
          set rbody to ""
          try
            set rbody to (body of r as string)
          end try
          set output to output & rid & tab & rname & tab & (rcompleted as string) & tab & rbody & "${APPLE_REMINDERS_SEARCH_DELIM}"
          set hitCount to hitCount + 1
        end repeat
      end tell
      return output
    `;
    const stdout = await this.runScript(script);
    return parseSearchOutput(stdout, trimmed, this.id);
  }

  private async runScript(script: string): Promise<string> {
    const result = await runCommandWithTimeout({
      command: this.osascriptPath,
      args: ["-"],
      stdin: script,
      timeoutMs: this.timeoutMs
    });

    if (result.timedOut) {
      throw new TasksProviderError(
        this.id,
        "OSASCRIPT_TIMEOUT",
        `osascript timed out after ${this.timeoutMs.toString()}ms and was killed (unanswered Reminders Automation prompt or a wedged Reminders.app?)`
      );
    }

    if (result.exitCode === 0) {
      return result.stdout;
    }

    if (/not allowed to access|don't have permission|not authorised/iu.test(result.stderr)) {
      throw new TasksProviderError(
        this.id,
        "REMINDERS_PERMISSION",
        "Reminders access permission denied — grant access in System Settings → Privacy & Security → Automation."
      );
    }

    throw new TasksProviderError(this.id, `EXIT_${result.exitCode ?? "UNKNOWN"}`, `osascript failed: ${result.stderr.trim().slice(0, 500)}`);
  }
}

/**
 * Per-entry delimiter for the search AppleScript output. Same
 * approach as `notes-providers-apple.ts` — a deliberately-unique
 * ASCII marker that's vanishingly unlikely to appear inside a
 * reminder body.
 */
const APPLE_REMINDERS_SEARCH_DELIM = "~~~MUSE_REMINDERS_SEARCH_END~~~";

function parseListOutput(output: string, providerId: string): readonly Task[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line): readonly Task[] => {
      const [id, title, createdIso, completedStr, completionIso, body] = line.split("\t");
      if (!id || !title) {
        return [];
      }
      const isDone = completedStr === "true";
      return [{
        createdAt: toDateOrNow(createdIso),
        id,
        providerId,
        status: isDone ? "done" : "open",
        title,
        ...(isDone && completionIso ? { completedAt: toDateOrNow(completionIso) } : {}),
        ...(body ? { notes: body } : {})
      }];
    });
}

function parseSearchOutput(output: string, query: string, providerId: string): readonly TaskSearchHit[] {
  const needle = query.toLowerCase();
  return output
    .split(APPLE_REMINDERS_SEARCH_DELIM)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .flatMap((entry): readonly TaskSearchHit[] => {
      const [id, title, completedStr, body] = entry.split("\t");
      if (!id || !title) {
        return [];
      }
      const status = completedStr === "true" ? "done" : "open";
      const lowerBody = (body ?? "").toLowerCase();
      const snippet = body && lowerBody.includes(needle) ? body.slice(0, 200) : undefined;
      return [{
        id,
        providerId,
        status,
        title,
        ...(snippet ? { snippet } : {})
      }];
    });
}

function toDateOrNow(iso: string | undefined): Date {
  if (!iso) {
    return new Date();
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
