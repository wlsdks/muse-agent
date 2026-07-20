import { mkdtempSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MuseEnvironment } from "../src/index.js";
import {
  resolveActionLogFile,
  resolveAuthoredSkillsDir,
  resolveBriefingSidecarFile,
  resolveContactsFile,
  resolveCredentialsFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveEpisodesFile,
  resolveFeedsFile,
  resolveDigestQueueFile,
  resolveFollowupLlmBudgetFile,
  resolveFollowupsFile,
  resolveInterruptionLedgerFile,
  resolveLastProactiveDeliveryFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveMessagingLogFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveObjectivesFile,
  resolvePatternsFiredFile,
  resolvePendingApprovalsFile,
  resolvePlanCacheFile,
  resolvePlaybookFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveSessionLockFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveUserSkillsDir,
  resolveVetoesFile,
} from "../src/provider-paths.js";

// An isolated HOME the whole test file resolves under: every default check
// asserts `<isoHome>/.muse/<name>`, never the owner's real home. This is what
// the fail-close guard requires — a test that omits it is refused (see the
// "fail-close under vitest" block below).
const isoHome = mkdtempSync(join(tmpdir(), "muse-provider-paths-"));
const env = (overrides: Record<string, string> = {}): MuseEnvironment =>
  ({ HOME: isoHome, ...overrides }) as MuseEnvironment;
const dotMuse = (name: string) => join(isoHome, ".muse", name);

// [resolver, env key it reads, default name under ~/.muse]
const RESOLVERS: ReadonlyArray<readonly [(e: MuseEnvironment) => string, string, string]> = [
  [resolveNotesDir, "MUSE_NOTES_DIR", "notes"],
  [resolveCredentialsFile, "MUSE_CREDENTIALS_FILE", "credentials.json"],
  [resolveLocalCalendarFile, "MUSE_CALENDAR_FILE", "calendar.json"],
  [resolveTasksFile, "MUSE_TASKS_FILE", "tasks.json"],
  [resolveMessagingCredentialsFile, "MUSE_MESSAGING_CREDENTIALS_FILE", "messaging.json"],
  [resolveMessagingLogFile, "MUSE_MESSAGING_LOG_FILE", "notifications.log"],
  [resolveRemindersFile, "MUSE_REMINDERS_FILE", "reminders.json"],
  [resolveReminderHistoryFile, "MUSE_REMINDER_HISTORY_FILE", "reminder-history.json"],
  [resolveProactiveHistoryFile, "MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json"],
  [resolveSessionLockFile, "MUSE_SESSION_LOCK_FILE", "session-lock.json"],
  [resolveFollowupsFile, "MUSE_FOLLOWUPS_FILE", "followups.json"],
  [resolveInterruptionLedgerFile, "MUSE_INTERRUPTION_LEDGER_FILE", "interruption-ledger.json"],
  [resolveDigestQueueFile, "MUSE_DIGEST_QUEUE_FILE", "digest-queue.json"],
  [resolveLastProactiveDeliveryFile, "MUSE_LAST_PROACTIVE_FILE", "last-proactive-delivery.json"],
  [resolveFeedsFile, "MUSE_FEEDS_FILE", "feeds.json"],
  [resolveFollowupLlmBudgetFile, "MUSE_FOLLOWUP_LLM_BUDGET_FILE", "followup-llm-budget.json"],
  [resolveObjectivesFile, "MUSE_OBJECTIVES_FILE", "objectives.json"],
  [resolveBriefingSidecarFile, "MUSE_BRIEFING_SIDECAR_FILE", "briefing-fired.json"],
  [resolveVetoesFile, "MUSE_VETOES_FILE", "vetoes.json"],
  [resolvePlaybookFile, "MUSE_PLAYBOOK_FILE", "playbook.json"],
  [resolvePlanCacheFile, "MUSE_PLAN_CACHE_FILE", "plan-cache.json"],
  [resolveActionLogFile, "MUSE_ACTION_LOG_FILE", "action-log.json"],
  [resolvePendingApprovalsFile, "MUSE_PENDING_APPROVALS_FILE", "pending-approvals.json"],
  [resolveEpisodesFile, "MUSE_EPISODES_FILE", "episodes.json"],
  [resolveContactsFile, "MUSE_CONTACTS_FILE", "contacts.json"],
  [resolvePatternsFiredFile, "MUSE_PATTERNS_FIRED_FILE", "patterns-fired.json"],
  [resolveLineInboxFile, "MUSE_LINE_INBOX_FILE", "line-inbox.json"],
  [resolveTelegramOffsetFile, "MUSE_TELEGRAM_OFFSET_FILE", "telegram-offset.json"],
  [resolveTelegramInboxFile, "MUSE_TELEGRAM_INBOX_FILE", "telegram-inbox.json"],
  [resolveDiscordAfterFile, "MUSE_DISCORD_AFTER_FILE", "discord-after.json"],
  [resolveDiscordInboxFile, "MUSE_DISCORD_INBOX_FILE", "discord-inbox.json"],
  [resolveSlackAfterFile, "MUSE_SLACK_AFTER_FILE", "slack-after.json"],
  [resolveSlackInboxFile, "MUSE_SLACK_INBOX_FILE", "slack-inbox.json"],
  [resolveUserSkillsDir, "MUSE_SKILLS_DIR", "skills"],
  [resolveAuthoredSkillsDir, "MUSE_AUTHORED_SKILLS_DIR", "skills/authored"],
  [resolveModelKeysFile, "MUSE_MODEL_KEYS_FILE", "models.json"],
];

describe("provider-paths shared resolution (via resolveTasksFile)", () => {
  it("defaults to <home>/.muse/<name> when the override is unset, blank, or whitespace", () => {
    expect(resolveTasksFile(env())).toBe(dotMuse("tasks.json"));
    expect(resolveTasksFile(env({ MUSE_TASKS_FILE: "" }))).toBe(dotMuse("tasks.json"));
    expect(resolveTasksFile(env({ MUSE_TASKS_FILE: "   " }))).toBe(dotMuse("tasks.json"));
  });

  it("uses a trimmed absolute override verbatim", () => {
    expect(resolveTasksFile(env({ MUSE_TASKS_FILE: "  /custom/tasks.json  " }))).toBe("/custom/tasks.json");
  });

  it("expands a leading ~ / ~/ override to the home directory", () => {
    expect(resolveTasksFile(env({ MUSE_TASKS_FILE: "~" }))).toBe(homedir());
    expect(resolveTasksFile(env({ MUSE_TASKS_FILE: "~/sub/x.json" }))).toBe(join(homedir(), "sub/x.json"));
  });

  it("leaves a ~otheruser override untouched (only the current-user form expands)", () => {
    expect(resolveTasksFile(env({ MUSE_TASKS_FILE: "~bob/x.json" }))).toBe("~bob/x.json");
  });
});

describe("each resolver maps to its own env key and default name", () => {
  it("falls back to the right <home>/.muse default for every resolver", () => {
    for (const [resolve, , defaultName] of RESOLVERS) {
      expect(resolve(env())).toBe(dotMuse(defaultName));
    }
  });

  it("reads exactly its own MUSE_* override (no copy-paste drift across the 32 resolvers)", () => {
    for (const [resolve, key] of RESOLVERS) {
      const sentinel = `/sentinel/${key}`;
      expect(resolve(env({ [key]: sentinel }))).toBe(sentinel);
    }
  });

  it("covers a distinct env key and default name per resolver", () => {
    expect(new Set(RESOLVERS.map(([, key]) => key)).size).toBe(RESOLVERS.length);
    expect(new Set(RESOLVERS.map(([, , name]) => name)).size).toBe(RESOLVERS.length);
  });
});

describe("fail-close under vitest — refuse the real-home store fallback", () => {
  // The genuine account home is what the guard forbids under vitest — writing
  // there is the pollution. `env.HOME` pointed at it forces the exact fallback
  // a test that forgot to isolate would hit (its ambient HOME still resolves
  // here when the per-file setup is absent).
  const realHome = userInfo().homedir;

  it("throws when a resolver would land on the genuine account home", () => {
    expect(() => resolveTasksFile({ HOME: realHome } as MuseEnvironment)).toThrow(/test isolation/i);
    expect(() => resolveActionLogFile({ HOME: realHome } as MuseEnvironment)).toThrow(/test isolation/i);
  });

  it("names the specific missing MUSE_* override in the thrown message (per-resolver, not generic)", () => {
    // Input-dependent: each resolver names ITS OWN key — a guard that hard-coded
    // one key or dropped the key entirely would fail one of these.
    expect(() => resolveTasksFile({ HOME: realHome } as MuseEnvironment)).toThrow(/MUSE_TASKS_FILE/);
    expect(() => resolveActionLogFile({ HOME: realHome } as MuseEnvironment)).toThrow(/MUSE_ACTION_LOG_FILE/);
    expect(() => resolvePlanCacheFile({ HOME: realHome } as MuseEnvironment)).toThrow(/MUSE_PLAN_CACHE_FILE/);
  });

  it("does NOT throw once the test isolates via env.HOME, and resolves under that tmp home", () => {
    // Output tracks the input HOME — proving the guard keys off the resolved
    // home (genuine vs tmp), not a blanket vitest refusal.
    expect(resolveTasksFile(env())).toBe(dotMuse("tasks.json"));
    const otherHome = mkdtempSync(join(tmpdir(), "muse-provider-paths-alt-"));
    expect(resolveTasksFile({ HOME: otherHome } as MuseEnvironment)).toBe(join(otherHome, ".muse", "tasks.json"));
  });

  it("does NOT throw when an explicit override is given even pointed at the real home", () => {
    // The override is itself the isolation decision, so the real-home fallback
    // never runs — the override wins before the guard.
    expect(resolveTasksFile({ HOME: realHome, MUSE_TASKS_FILE: "/custom/t.json" } as MuseEnvironment)).toBe(
      "/custom/t.json"
    );
  });
});
