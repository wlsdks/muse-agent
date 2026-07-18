import { homedir, userInfo } from "node:os";
import { join as pathJoin } from "node:path";

import type { MuseEnvironment } from "./index.js";

/**
 * Every personal-providers path resolver shares the same shape:
 * trim the env override, fall back to a default under `~/.muse/`.
 * Encoding it once keeps each resolver a one-liner and stops
 * copy-paste drift when a new data file joins the set.
 */
// A `MUSE_*` path override commonly carries a leading `~` (docs
// show `~/.muse/...`; systemd `Environment=`, Docker `-e`, .env
// files, and quoted shell assignments do NOT expand it, and Node
// never does). Without this the value lands literally and state
// is written into a bogus `./~/` directory. Only the unambiguous
// current-user forms (`~`, `~/…`) expand; `~otheruser` is left
// alone.
function expandLeadingTilde(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return pathJoin(homedir(), p.slice(2));
  }
  return p;
}

// The OWNER's real home, read from the OS account (getpwuid), NOT from
// `$HOME`. `os.homedir()` follows a mutated `process.env.HOME`, so it can't
// tell an isolated test HOME from the genuine one; `userInfo().homedir` is the
// account truth and is immune to that mutation — exactly what the guard needs
// to recognise "this would write into the developer's actual ~/.muse". Cached
// once (the syscall is stable); falls back to homedir() on the rare no-passwd
// box (some containers) where userInfo() throws.
const genuineHomeDir = ((): string => {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
})();

function runningUnderVitest(): boolean {
  return Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
}

function resolveDotMusePath(env: MuseEnvironment, envKey: string, defaultName: string): string {
  const override = env[envKey]?.trim();
  if (override && override.length > 0) {
    return expandLeadingTilde(override);
  }
  // HOME-first like @muse/shared resolveHomeDir: os.homedir() ignores $HOME on
  // win32 (USERPROFILE), which would break HOME-based isolation (tests, muse demo).
  // Ambient process.env.HOME backs a caller-scoped env that omits HOME, matching
  // the api tick resolvers' convention.
  const home = env.HOME?.trim() || process.env.HOME?.trim();
  const resolvedHome = home && home.length > 0 ? home : homedir();
  // Fail-close under vitest: refuse to fall through to the owner's REAL home.
  // A test that forgets to isolate ~/.muse (no `${envKey}` override AND no
  // isolated `env.HOME`) must fail LOUD here instead of silently writing into
  // the real store. Production (no vitest env) keeps the real ~/.muse as before.
  if (runningUnderVitest() && resolvedHome === genuineHomeDir) {
    throw new Error(
      `[muse test isolation] ${envKey} store path would fall back to the REAL home ` +
        `(${pathJoin(resolvedHome, ".muse", defaultName)}) under vitest. ` +
        `Isolate the test: pass an explicit env.HOME=<tmpdir>, or set ${envKey} to a temp path. ` +
        `Refusing to write to the owner's real ~/.muse.`
    );
  }
  return pathJoin(resolvedHome, ".muse", defaultName);
}

export function resolveNotesDir(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_NOTES_DIR", "notes");
}

/** Local-first token-usage ledger (JSONL) — where the no-DB product persists
 *  per-call usage so `muse cost` works without the API server. */
export function resolveTokenUsageFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_TOKEN_USAGE_FILE", "token-usage.jsonl");
}

/** Local-first checkpoint directory — where the no-DB product persists per-run
 *  execution checkpoints so a crashed run can resume (one JSON file per runId). */
export function resolveCheckpointsDir(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CHECKPOINTS_DIR", "checkpoints");
}

export function resolveNotesIndexFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_NOTES_INDEX_FILE", "notes-index.json");
}

export function resolveCredentialsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CREDENTIALS_FILE", "credentials.json");
}

export function resolveLocalCalendarFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CALENDAR_FILE", "calendar.json");
}

export function resolveCalendarIcsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CALENDAR_ICS_FILE", "calendar.ics");
}

export function resolveTasksFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_TASKS_FILE", "tasks.json");
}

/** `muse work` — the Work store (docs/design/muse-work.md): a named goal binding flows/board tasks/a continuity thread. */
export function resolveWorksFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_WORKS_FILE", "works.json");
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

/** The Whetstone weakness ledger — what Muse couldn't answer / didn't actually do. */
export function resolveWeaknessesFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_WEAKNESSES_FILE", "weaknesses.json");
}

export function resolveProactiveHistoryFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json");
}

/**
 * `~/.muse/session-lock.json` by default; overridable
 * via `MUSE_SESSION_LOCK_FILE` (tests use a tempdir to avoid
 * touching the user's real home).
 */
export function resolveSessionLockFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_SESSION_LOCK_FILE", "session-lock.json");
}

export function resolveFollowupsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_FOLLOWUPS_FILE", "followups.json");
}

export function resolveFeedsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_FEEDS_FILE", "feeds.json");
}

export function resolveBrowsingFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_BROWSING_FILE", "browsing.json");
}

export function resolveFollowupLlmBudgetFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_FOLLOWUP_LLM_BUDGET_FILE", "followup-llm-budget.json");
}

export function resolveObjectivesFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_OBJECTIVES_FILE", "objectives.json");
}

export function resolveBriefingSidecarFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_BRIEFING_SIDECAR_FILE", "briefing-fired.json");
}

export function resolveVetoesFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_VETOES_FILE", "vetoes.json");
}

export function resolvePlaybookFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PLAYBOOK_FILE", "playbook.json");
}

export function resolveSuppressedLessonsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_SUPPRESSED_LESSONS_FILE", "suppressed-lessons.json");
}

export function resolveLearningPauseFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_LEARNING_PAUSE_FILE", "learning-paused.json");
}

export function resolvePlanCacheFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PLAN_CACHE_FILE", "plan-cache.json");
}

/** Local Personal Continuity threads, links, delivery receipts, and display policy. */
export function resolveAttunementFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_ATTUNEMENT_FILE", "attunement.json");
}

/** Owner-only progressive-autonomy grants, journals, and shadow receipts. */
export function resolveProgressiveAutonomyFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PROGRESSIVE_AUTONOMY_FILE", "progressive-autonomy.json");
}

/** Organic, read-only runtime opportunity evidence; separate from grants and executions. */
export function resolveProgressiveAutonomyOpportunitiesFile(env: MuseEnvironment): string {
  return resolveDotMusePath(
    env,
    "MUSE_PROGRESSIVE_AUTONOMY_OPPORTUNITIES_FILE",
    "progressive-autonomy-opportunities.json"
  );
}

export function resolveActionLogFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_ACTION_LOG_FILE", "action-log.json");
}

export function resolvePendingApprovalsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PENDING_APPROVALS_FILE", "pending-approvals.json");
}

export function resolveEpisodesFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_EPISODES_FILE", "episodes.json");
}

export function resolveNoteProvenanceFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_NOTE_PROVENANCE_FILE", "note-provenance.json");
}

export function resolveContactsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CONTACTS_FILE", "contacts.json");
}

export function resolvePatternsFiredFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_PATTERNS_FIRED_FILE", "patterns-fired.json");
}

/** Rejected Builder automation proposals ("사양할게요") — a rejected pattern id never re-proposes. */
export function resolveRejectedProposalsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_AUTOMATION_REJECTED_PROPOSALS_FILE", "automation-rejected-proposals.json");
}

export function resolveRecallHitsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_RECALL_HITS_FILE", "recall-hits.json");
}

/**
 * FACT recall-hits ledger — a SEPARATE file from the episode `recall-hits.json`.
 * Kept apart on purpose: the memory-consolidate / fade passes iterate the EPISODE
 * ledger's keys AS episode sessionIds, so mixing fact keys into it would corrupt
 * episode fade/promotion. Fact-recall hits (a fact SURFACED in retrieval results)
 * therefore live here and feed the fact-promotion recall gate only.
 */
export function resolveFactRecallHitsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_FACT_RECALL_HITS_FILE", "fact-recall-hits.json");
}

export function resolveFadedMemoriesFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_FADED_MEMORIES_FILE", "memory-fade.json");
}

export function resolveCheckinsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_CHECKINS_FILE", "checkins.json");
}

/** The shared interruption-budget delivery ledger every UNASKED notice loop
 *  gates its send against (`packages/stores/interruption-budget.ts`). */
export function resolveInterruptionLedgerFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_INTERRUPTION_LEDGER_FILE", "interruption-ledger.json");
}

/** The shared digest queue a budget-suppressed notice lands in instead of
 *  sending (`packages/stores/digest-queue.ts`). */
export function resolveDigestQueueFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_DIGEST_QUEUE_FILE", "digest-queue.json");
}

/** The once-per-day "already sent" sidecar the digest flush dedupes against
 *  (`packages/stores/digest-sent-store.ts`). */
export function resolveDigestSentFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_DIGEST_SENT_FILE", "digest-sent.json");
}

/** The sidecar recording each UNASKED loop's most recent delivered/digested
 *  notice, read by the channel-veto reply handler to resolve "what did Muse
 *  just send me" (`packages/stores/last-proactive-delivery-store.ts`). */
export function resolveLastProactiveDeliveryFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_LAST_PROACTIVE_FILE", "last-proactive-delivery.json");
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

export function resolveMatrixSinceFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_MATRIX_SINCE_FILE", "matrix-since.json");
}

export function resolveMatrixInboxFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_MATRIX_INBOX_FILE", "matrix-inbox.json");
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

export function resolveAuthoredSkillsDir(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_AUTHORED_SKILLS_DIR", "skills/authored");
}

export function resolveSkillRewardsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_SKILL_REWARDS_FILE", "skill-rewards.json");
}

export function resolveReflectionsFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_REFLECTIONS_FILE", "reflections.json");
}

export function resolveWorkspaceSkillsDir(env: MuseEnvironment): string | undefined {
  const override = env.MUSE_WORKSPACE_SKILLS_DIR?.trim();
  return override && override.length > 0 ? expandLeadingTilde(override) : undefined;
}

export function resolveInboxInjectionCursorFile(env: MuseEnvironment, providerId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(providerId)) {
    throw new RangeError("providerId must contain only letters, numbers, underscores, or hyphens");
  }
  return resolveDotMusePath(
    env,
    `MUSE_${providerId.toUpperCase()}_INBOX_INJECTION_CURSOR_FILE`,
    `${providerId}-inbox-injection.json`
  );
}

export function resolveModelKeysFile(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_MODEL_KEYS_FILE", "models.json");
}

/**
 * Directory holding per-remote-MCP-server OAuth 2.1 state (one
 * `<serverId>.json` per server: tokens, DCR client info, PKCE verifier,
 * CSRF state). Kept OUT of `mcp.json` (the server registry) so a token is
 * never written into the config a user edits/shares, and encrypted at rest
 * via the credential-encryption helpers when `MUSE_CREDENTIALS_ENCRYPT` is on.
 */
export function resolveOAuthStoreDir(env: MuseEnvironment): string {
  return resolveDotMusePath(env, "MUSE_MCP_OAUTH_DIR", "mcp-oauth");
}

/**
 * Same test-isolation contract as `resolveDotMusePath`, but joins
 * `.config/muse/<name>` — the CLI's OWN config-file convention
 * (`~/.config/muse/config.json`, written by `muse config set` /
 * `muse setup local` / `muse setup cloud`), a different tree from the
 * `~/.muse/` personal-data files the rest of this file resolves.
 */
function resolveDotConfigMusePath(env: MuseEnvironment, envKey: string, defaultName: string): string {
  const override = env[envKey]?.trim();
  if (override && override.length > 0) {
    return expandLeadingTilde(override);
  }
  const home = env.HOME?.trim() || process.env.HOME?.trim();
  const resolvedHome = home && home.length > 0 ? home : homedir();
  if (runningUnderVitest() && resolvedHome === genuineHomeDir) {
    throw new Error(
      `[muse test isolation] ${envKey} config path would fall back to the REAL home ` +
        `(${pathJoin(resolvedHome, ".config", "muse", defaultName)}) under vitest. ` +
        `Isolate the test: pass an explicit env.HOME=<tmpdir>, or set ${envKey} to a temp path. ` +
        `Refusing to write to the owner's real ~/.config/muse.`
    );
  }
  return pathJoin(resolvedHome, ".config", "muse", defaultName);
}

/**
 * `~/.config/muse/config.json` — the SAME file `apps/cli/src/program-config.ts`'s
 * `defaultConfigPath`/`readConfigStore`/`writeConfigStore` resolve to by
 * default (that module has no env-override key for this path; it exists
 * only here so a non-CLI surface can point a test at an isolated temp
 * file). Exists so `apps/api`'s `/model <name>` channel switch — which
 * cannot import apps/cli, a separate app, not a shared package — writes
 * the identical file the next `muse chat`/`muse tui` invocation reads
 * (R3-3, model-registry.ts).
 */
export function resolveMuseCliConfigFilePath(env: MuseEnvironment): string {
  return resolveDotConfigMusePath(env, "MUSE_CLI_CONFIG_FILE", "config.json");
}
