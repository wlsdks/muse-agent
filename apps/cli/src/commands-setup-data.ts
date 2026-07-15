/**
 * `muse setup data` — the "connect your data" wizard.
 *
 * A fresh Muse install sits on an empty `~/.muse`: every sensor / mirror
 * shipped this cycle (Apple Contacts, Chrome browsing ingest, the Apple
 * Reminders / Notes mirrors) is opt-in and therefore OFF, so the personal
 * model has no fuel. This one guided flow makes them discoverable and
 * one-command enableable — the activation multiplier over the data famine.
 *
 * Consent is preserved verbatim: every step defaults to NO and only runs /
 * stages on an explicit yes. One-shot actions (contacts import, browsing
 * sync) RUN NOW and show the real count; standing switches (auto-sync, the
 * mirrors) are STAGED into a copy-pasteable env block — Muse has no
 * config-file→env hydration for MUSE_* switches (only model keys hydrate via
 * autoconfigure), so the honest persistence for a standing switch is a shell
 * `export`, exactly as `muse setup cloud` does. A per-step failure (a TCC
 * prompt / timeout on contacts) warns and continues — it never kills the wizard.
 */

import { confirm, isCancel } from "@clack/prompts";
import {
  BROWSING_SYNC_LIMIT,
  defaultBrowsingFile,
  locateChromeHistoryFile,
  syncBrowsingHistory
} from "@muse/recall";
import type { Command } from "commander";
import { parseBooleanFromEnv } from "@muse/shared";

import { isNoInput } from "./cli-context.js";
import { importAppleContacts } from "./commands-contacts.js";
import { defaultEmbedModel } from "./council-corpus.js";
import { embed } from "./embed.js";
import type { ProgramIO } from "./program.js";

export interface ContactsImportOutcome {
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
  readonly total: number;
}

export interface BrowsingSyncOutcome {
  readonly synced: number;
  readonly total: number;
}

/**
 * The one-shot side effects the wizard RUNS NOW when a step is accepted.
 * Injectable so the flow is testable without touching Apple Contacts / Chrome.
 */
export interface DataSetupActions {
  readonly importContacts: () => Promise<ContactsImportOutcome>;
  readonly syncBrowsing: () => Promise<BrowsingSyncOutcome>;
}

/** Per-flag opt-ins for scripted / non-interactive use (no blanket `--yes`). */
export interface DataSetupFlags {
  readonly contacts?: boolean;
  readonly browsing?: boolean;
  readonly browsingAuto?: boolean;
  readonly remindersMirror?: boolean;
  readonly notesMirror?: boolean;
}

export interface DataSetupDeps {
  readonly io: ProgramIO;
  /** Resolve one consent question; the wizard passes `false` as the default. */
  readonly confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
  readonly actions: DataSetupActions;
  readonly flags: DataSetupFlags;
  readonly env: NodeJS.ProcessEnv;
}

export interface DataSetupResult {
  readonly contacts?: ContactsImportOutcome;
  readonly browsing?: BrowsingSyncOutcome;
  /** `export FOO=true` lines for the switches the user accepted this run. */
  readonly stagedSwitches: readonly string[];
  /** Switch env vars already `true` in the environment (no need to re-stage). */
  readonly alreadyEnabled: readonly string[];
  /** Step ids the user declined (or left off in flag mode). */
  readonly declined: readonly string[];
  /** Step ids whose action threw — warned and skipped, not fatal. */
  readonly failed: readonly string[];
}

type StepKind = "action" | "switch";

interface DataStep {
  readonly id: keyof DataSetupFlags;
  readonly kind: StepKind;
  /** Consent prompt (English, matches the surrounding setup surface). */
  readonly prompt: string;
  /** One-line WHY — bilingual so a Korean user sees the payoff immediately. */
  readonly why: string;
  /** Standing switch env var (switch steps only). */
  readonly envVar?: string;
}

export const DATA_STEPS: readonly DataStep[] = [
  {
    id: "contacts",
    kind: "action",
    prompt: "Import your Apple Contacts now?",
    why: "생일·기념일 브리핑의 연료가 됩니다 (powers birthday & anniversary briefings)."
  },
  {
    id: "browsing",
    kind: "action",
    prompt: "Sync your Chrome browsing history into local recall now?",
    why: "\"지난주에 본 그 블로그\" 회상이 가능해집니다 (\"what was that blog last week?\" recall) — 100% local."
  },
  {
    id: "browsingAuto",
    kind: "switch",
    envVar: "MUSE_BROWSING_AUTO_SYNC",
    prompt: "Keep browsing history auto-syncing in the background?",
    why: "데몬이 주기적으로 새 방문을 자동 동기화합니다 (the daemon keeps recall fresh)."
  },
  {
    id: "remindersMirror",
    kind: "switch",
    envVar: "MUSE_APPLE_REMINDERS_MIRROR",
    prompt: "Mirror Apple Reminders so `muse remind` reflects them?",
    why: "Apple 미리 알림과 양방향으로 연결됩니다 (two-way Reminders sync)."
  },
  {
    id: "notesMirror",
    kind: "switch",
    envVar: "MUSE_APPLE_NOTES_MIRROR",
    prompt: "Mirror Apple Notes into recall?",
    why: "Apple 메모를 회상·인용 대상으로 가져옵니다 (Notes become citable recall)."
  }
];

function isSwitchEnabled(env: NodeJS.ProcessEnv, envVar: string): boolean {
  return parseBooleanFromEnv(env[envVar], false);
}

/** Whether the caller passed any per-flag opt-in (scripted, non-interactive path). */
function isFlagMode(flags: DataSetupFlags): boolean {
  return Boolean(flags.contacts || flags.browsing || flags.browsingAuto || flags.remindersMirror || flags.notesMirror);
}

/**
 * Drive the wizard. Pure of its own IO except through `deps` — one consent
 * decision per step (default NO), then RUN (action) or STAGE (switch). A
 * declined step does nothing; a thrown action is warned and skipped so one
 * bad step can't abort the rest. Returns the exact reality for the summary +
 * tests (nothing ran / staged on all-decline is the consent pin).
 */
export async function runDataSetup(deps: DataSetupDeps): Promise<DataSetupResult> {
  const { actions, confirm: ask, env, flags, io } = deps;
  const flagMode = isFlagMode(flags);

  let contacts: ContactsImportOutcome | undefined;
  let browsing: BrowsingSyncOutcome | undefined;
  const stagedSwitches: string[] = [];
  const alreadyEnabled: string[] = [];
  const declined: string[] = [];
  const failed: string[] = [];

  for (const step of DATA_STEPS) {
    if (step.kind === "switch" && step.envVar && isSwitchEnabled(env, step.envVar)) {
      alreadyEnabled.push(step.envVar);
      continue;
    }

    const accepted = flagMode ? Boolean(flags[step.id]) : await ask(`${step.prompt}\n  → ${step.why}`, false);
    if (!accepted) {
      declined.push(step.id);
      continue;
    }

    if (step.kind === "switch" && step.envVar) {
      stagedSwitches.push(`export ${step.envVar}=true`);
      continue;
    }

    try {
      if (step.id === "contacts") {
        contacts = await actions.importContacts();
        io.stdout(`  ✓ Contacts: imported ${contacts.imported.toString()} new, updated ${contacts.updated.toString()} (of ${contacts.total.toString()} read).\n`);
      } else if (step.id === "browsing") {
        browsing = await actions.syncBrowsing();
        io.stdout(`  ✓ Browsing: synced ${browsing.synced.toString()} new visit(s) (total ${browsing.total.toString()}).\n`);
      }
    } catch (cause) {
      failed.push(step.id);
      io.stderr(`  ⚠ ${step.id} step failed (continuing): ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  }

  return { alreadyEnabled, browsing, contacts, declined, failed, stagedSwitches };
}

/** Render the closing summary: what ran, what to export, and the try-it-now line. */
export function renderDataSetupSummary(io: ProgramIO, result: DataSetupResult): void {
  io.stdout("\n— Summary —\n");
  if (result.contacts) {
    io.stdout(`  contacts: +${result.contacts.imported.toString()} imported, ${result.contacts.updated.toString()} updated\n`);
  }
  if (result.browsing) {
    io.stdout(`  browsing: +${result.browsing.synced.toString()} visits synced\n`);
  }
  if (result.alreadyEnabled.length > 0) {
    io.stdout(`  already on: ${result.alreadyEnabled.join(", ")}\n`);
  }

  if (result.stagedSwitches.length > 0) {
    io.stdout("\nTo keep these standing switches on, add them to your shell profile (~/.zshrc):\n");
    io.stdout("  (Muse reads MUSE_* switches from the environment — there is no config file for them.)\n");
    for (const line of result.stagedSwitches) io.stdout(`  ${line}\n`);
  }

  if (!result.contacts && !result.browsing && result.stagedSwitches.length === 0) {
    io.stdout("  Nothing enabled — run `muse setup data` again whenever you're ready.\n");
    return;
  }

  io.stdout("\nTry it now:\n  $ muse ask \"지난주에 본 블로그 뭐였지?\"\n");
  io.stdout("More sources you can connect any time:\n");
  io.stdout("  • Voice (local STT/TTS): muse setup voice\n");
  io.stdout("  • RSS/Atom feeds:        muse feeds add <url>\n");
}

/**
 * Run the data-connect steps in FLAG mode with the real default actions —
 * the reuse seam for the first-run wizard, so ingestion is never hand-rolled
 * elsewhere. Only the flag-selected steps run; the rest are declined.
 */
export async function runDataSetupInFlagMode(
  io: Pick<ProgramIO, "stdout" | "stderr">,
  flags: DataSetupFlags,
  env: NodeJS.ProcessEnv = process.env
): Promise<DataSetupResult> {
  return runDataSetup({
    actions: { importContacts: defaultImportContacts, syncBrowsing: defaultSyncBrowsing },
    confirm: async () => false,
    env,
    flags,
    io: io as ProgramIO
  });
}

async function defaultSyncBrowsing(): Promise<BrowsingSyncOutcome> {
  const historyFile = await locateChromeHistoryFile();
  if (!historyFile) {
    throw new Error("Chrome history not found — set MUSE_CHROME_HISTORY_FILE (or MUSE_CHROME_PROFILE)");
  }
  return syncBrowsingHistory({
    embed: (text) => embed(text, defaultEmbedModel(process.env)),
    historyFile,
    limit: BROWSING_SYNC_LIMIT,
    storeFile: defaultBrowsingFile()
  });
}

async function defaultImportContacts(): Promise<ContactsImportOutcome> {
  const result = await importAppleContacts();
  if (!result.ok) {
    throw new Error(result.error ?? "could not read Apple Contacts");
  }
  return { imported: result.imported, skipped: result.skipped, total: result.total, updated: result.updated };
}

export function registerSetupDataCommand(program: Command, io: ProgramIO): void {
  const setupRoot = program.commands.find((cmd) => cmd.name() === "setup");
  if (!setupRoot) {
    throw new Error("registerSetupDataCommand: 'setup' command group must be registered first.");
  }
  setupRoot
    .command("data")
    .description("Connect your data: guided opt-in for Apple Contacts, browsing history, and the Reminders/Notes mirrors")
    .addHelpText("after", `
Examples:
  $ muse setup data              # guided opt-in for every source (all default OFF)
  $ muse setup data --contacts   # import Apple Contacts now (non-interactive)
  $ muse setup data --browsing   # sync Chrome browsing history now`)
    .option("--contacts", "Non-interactive: import Apple Contacts now")
    .option("--browsing", "Non-interactive: sync Chrome browsing history now")
    .option("--browsing-auto", "Non-interactive: stage MUSE_BROWSING_AUTO_SYNC=true")
    .option("--reminders-mirror", "Non-interactive: stage MUSE_APPLE_REMINDERS_MIRROR=true")
    .option("--notes-mirror", "Non-interactive: stage MUSE_APPLE_NOTES_MIRROR=true")
    .action(async (options: {
      readonly contacts?: boolean;
      readonly browsing?: boolean;
      readonly browsingAuto?: boolean;
      readonly remindersMirror?: boolean;
      readonly notesMirror?: boolean;
    }) => {
      io.stdout("Connect your data — every source below is opt-in and defaults to OFF.\n");
      io.stdout("Muse learns YOU from what you connect; nothing turns on without your yes.\n\n");

      const result = await runDataSetup({
        actions: { importContacts: defaultImportContacts, syncBrowsing: defaultSyncBrowsing },
        confirm: async (message, defaultValue) => {
          // `--no-input` (or a non-TTY stdin) means "never prompt" — take the
          // safe default (every step defaults to NO) instead of blocking on a
          // clack prompt that would hang a piped / scripted invocation.
          if (isNoInput() || !process.stdin.isTTY) return defaultValue;
          const answer = await confirm({ initialValue: defaultValue, message });
          return isCancel(answer) ? false : answer === true;
        },
        env: process.env,
        flags: {
          browsing: options.browsing,
          browsingAuto: options.browsingAuto,
          contacts: options.contacts,
          notesMirror: options.notesMirror,
          remindersMirror: options.remindersMirror
        },
        io
      });

      renderDataSetupSummary(io, result);
    });
}
