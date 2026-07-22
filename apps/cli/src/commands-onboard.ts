/**
 * `muse onboard` — the guided path from install to the first cited answer.
 * Muse's wedge only lands if a non-technical, privacy-bound user can FEEL it in
 * five minutes; this command checks readiness and prints the SINGLE next
 * command to run, step by step, until `muse ask` returns a source-cited answer
 * from their own machine. Deterministic: the step logic is pure + tested; the
 * command only gathers state (Ollama reachability, installed models, notes
 * corpus, index) and renders.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LOCAL_FIRST_DEFAULT_MODEL, resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

import { isNoInput } from "./cli-context.js";
import { detectLangFromLocale, type Lang } from "./cli-i18n.js";
import { installDaemonAutostart, type DaemonHelpers } from "./commands-daemon.js";
import { readDaemonConfig, resolveDaemonConfigFile, writeDaemonConfig } from "./commands-daemon-config.js";
import { readConfigStore, writeConfigStore } from "./program-config.js";
import type { ProgramIO } from "./program.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import { probeOllamaModels } from "./ollama-probe.js";

export interface OnboardingState {
  readonly ollamaReachable: boolean;
  /** Model names from Ollama's /api/tags (e.g. "qwen3:8b", "nomic-embed-text:latest"). */
  readonly installedModels: readonly string[];
  /** Resolved local chat model base (e.g. "qwen3:8b"). */
  readonly chatModel: string;
  readonly embedModel: string;
  readonly notesDir: string;
  readonly noteFileCount: number;
  readonly indexBuilt: boolean;
  /** People in the local contacts graph — 0 means Apple Contacts never imported. */
  readonly contactsCount?: number;
  /** Visits in the local browsing archive — 0 means browsing never synced. */
  readonly browsingVisitCount?: number;
}

interface OnboardStep {
  readonly id: string;
  readonly title: string;
  readonly status: "ok" | "action";
  readonly detail: string;
  readonly command?: string;
}

export interface OnboardReport {
  readonly steps: readonly OnboardStep[];
  readonly ready: boolean;
  /** The single next command the user should run (the first unmet step), or the ask example when ready. */
  readonly nextCommand: string;
  readonly nextTitle: string;
  /**
   * A non-blocking nudge shown when the personal sensors are still empty
   * (no contacts, no browsing) — it points at `muse setup data` without
   * gating readiness, since a cited answer from notes needs neither.
   */
  readonly dataHint?: { readonly detail: string; readonly command: string };
}

function modelInstalled(installed: readonly string[], name: string): boolean {
  const base = name.split(":")[0];
  return installed.some((m) => m === name || m.split(":")[0] === base);
}

const ASK_EXAMPLE = "muse ask --notes-only \"<a question about something in your notes>\"";

/**
 * Pure: given readiness state, produce the ordered steps + the SINGLE next
 * command. Steps are checked in dependency order (Ollama → chat model → embed
 * model → corpus → index → ask); `nextCommand` is the first step needing
 * action, or the ask example once every prerequisite is met.
 */
export function computeOnboarding(state: OnboardingState): OnboardReport {
  const steps: OnboardStep[] = [];
  const ok = (id: string, title: string, detail: string): OnboardStep => ({ detail, id, status: "ok", title });
  const action = (id: string, title: string, detail: string, command: string): OnboardStep => ({ command, detail, id, status: "action", title });

  steps.push(state.ollamaReachable
    ? ok("ollama", "Local model server (Ollama)", "Ollama is reachable.")
    : action("ollama", "Local model server (Ollama)", "Muse runs on a local model — start Ollama first.", "ollama serve"));

  steps.push(modelInstalled(state.installedModels, state.chatModel)
    ? ok("chat-model", `Chat model (${state.chatModel})`, "Installed.")
    : action("chat-model", `Chat model (${state.chatModel})`, "The local model Muse answers with.", `ollama pull ${state.chatModel}`));

  steps.push(modelInstalled(state.installedModels, state.embedModel)
    ? ok("embed-model", `Embedding model (${state.embedModel})`, "Installed.")
    : action("embed-model", `Embedding model (${state.embedModel})`, "Embeds your notes so Muse can find + cite them.", `ollama pull ${state.embedModel}`));

  steps.push(state.noteFileCount > 0
    ? ok("corpus", "Your corpus", `${state.noteFileCount.toString()} file(s) under ${state.notesDir}.`)
    : action("corpus", "Your corpus", `Add the notes/files you'd never paste into ChatGPT (drop them in ${state.notesDir}), or ingest an export.`, "muse ingest <chatgpt-or-claude-export.json | mail.mbox>"));

  steps.push(state.indexBuilt
    ? ok("index", "Search index", "Built — your corpus is searchable.")
    : action("index", "Search index", "Embed your corpus so cited recall works.", "muse notes reindex"));

  const firstAction = steps.find((s) => s.status === "action");
  const ready = firstAction === undefined;
  const noPersonalData = (state.contactsCount ?? 0) === 0 && (state.browsingVisitCount ?? 0) === 0;
  return {
    nextCommand: firstAction?.command ?? ASK_EXAMPLE,
    nextTitle: ready ? "Ask your own machine" : firstAction.title,
    ready,
    steps,
    ...(noPersonalData
      ? { dataHint: { command: "muse setup data", detail: "Connect your data (Apple Contacts, browsing, mirrors) so Muse can learn you — every source is opt-in." } }
      : {})
  };
}

function countCorpusFiles(dir: string, cap = 1_000): number {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0 && count < cap) {
    let entries;
    try {
      entries = readdirSync(stack.pop()!, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join((e as unknown as { parentPath?: string; path?: string }).parentPath ?? (e as unknown as { path: string }).path ?? dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /\.(md|markdown|txt|pdf)$/iu.test(e.name)) count += 1;
      if (count >= cap) break;
    }
  }
  return count;
}

async function gatherState(io: ProgramIO): Promise<OnboardingState> {
  const env = process.env;
  const baseUrl = (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/u, "");
  let ollamaReachable = false;
  let installedModels: string[] = [];
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const probeResult = await probeOllamaModels(baseUrl, { fetchImpl, timeoutMs: 3_000 });
  if (probeResult.reachable) {
    ollamaReachable = true;
    installedModels = probeResult.models.map((model) => model.name);
  }
  const chatModel = (env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL ?? LOCAL_FIRST_DEFAULT_MODEL).replace(/^ollama\//u, "");
  const embedModel = env.MUSE_EPISODIC_RECALL_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
  const notesDir = resolveNotesDir(env as Record<string, string | undefined>);
  const noteFileCount = countCorpusFiles(notesDir);
  const indexFile = env.MUSE_NOTES_INDEX_FILE?.trim() || join(homedir(), ".muse", "notes-index.json");
  const { browsingVisitCount, contactsCount } = await countPersonalData(env as Record<string, string | undefined>);
  return { browsingVisitCount, chatModel, contactsCount, embedModel, indexBuilt: existsSync(indexFile), installedModels, notesDir, noteFileCount, ollamaReachable };
}

/**
 * Best-effort count of the personal sensors' stores (contacts, browsing) for
 * the connect-your-data nudge. Any read failure counts as 0 (empty ⇒ nudge),
 * never throws — the readiness report must not depend on these stores existing.
 */
async function countPersonalData(env: Record<string, string | undefined>): Promise<{ contactsCount: number; browsingVisitCount: number }> {
  const contactsCount = await safeCount(async () => {
    const { resolveContactsFile } = await import("@muse/autoconfigure");
    const { queryContacts } = await import("@muse/stores");
    return (await queryContacts(resolveContactsFile(env))).length;
  });
  const browsingVisitCount = await safeCount(async () => {
    const { defaultBrowsingFile, readBrowsingStore } = await import("@muse/recall");
    return (await readBrowsingStore(defaultBrowsingFile())).visits.length;
  });
  return { browsingVisitCount, contactsCount };
}

async function safeCount(read: () => Promise<number>): Promise<number> {
  try {
    return await read();
  } catch {
    return 0;
  }
}

export interface OnboardHelpers {
  /**
   * Test seam for the FIRST interactive question (AC1) — bypasses the real
   * TTY/`--no-input` gate and `@clack/prompts` entirely; a test injects the
   * answer directly. Absent → the real interactive select (skipped on any
   * non-TTY or `--no-input` run, falling back to OS-locale auto-detect so a
   * piped/CI onboard never hangs on a language choice).
   */
  readonly selectLanguage?: (defaultLang: Lang) => Promise<Lang | undefined>;
  /**
   * Test seam — bypasses the real TTY/`--no-input` gate and `@clack/prompts`
   * entirely; a test injects the answer directly. Absent → the real
   * interactive confirm (skipped, safe-default `false`, on any non-TTY or
   * `--no-input` run — the background daemon offer never hangs a piped
   * onboard).
   */
  readonly confirm?: (message: string) => Promise<boolean>;
  /** Test seam — platform override for the install path (mirrors `DaemonHelpers.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Stable-entry validation seams shared with `muse daemon --install`. */
  readonly daemonCliEntry?: DaemonHelpers["daemonCliEntry"];
  readonly daemonTemporaryRoots?: DaemonHelpers["daemonTemporaryRoots"];
  readonly runLaunchctl?: DaemonHelpers["runLaunchctl"];
  readonly schtasksRun?: DaemonHelpers["schtasksRun"];
  /**
   * Test seam — bypasses the real TTY/`--no-input` gate for the native
   * macOS-notification offer; a test injects the answer directly. Absent →
   * the real interactive confirm (skipped, safe-default `false`, on any
   * non-TTY or `--no-input` run).
   */
  readonly confirmNotifications?: (message: string) => Promise<boolean>;
}

const BACKGROUND_INSTALL_HINT = "Keep Muse running in the background any time — reminders, briefings, and schedules keep firing even with the terminal closed:\n   $ muse daemon --install\n";

/**
 * A state-changing action (installs a persistent LaunchAgent/scheduled
 * task) — unlike `muse setup data`'s opt-in steps, the visible prompt
 * defaults to YES (this is the offer's whole point), but a non-interactive
 * run (`--no-input`, no TTY, or piped) NEVER installs unattended: it
 * returns `false` and the caller falls back to the manual-command hint,
 * exactly `cli-context.ts`'s "safe non-interactive default" contract.
 */
async function defaultConfirmBackgroundDaemon(message: string): Promise<boolean> {
  if (isNoInput() || !process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({ initialValue: true, message });
  return isCancel(answer) ? false : answer === true;
}

/**
 * The closing background-daemon offer — asked only on a platform
 * `muse daemon --install` actually supports (darwin/win32); every other
 * platform (or a "no"/cancelled answer) prints the manual command instead.
 * Fail-soft throughout: an install failure (or a thrown error from the
 * injected runner seams) never fails `muse onboard` itself, it just falls
 * back to the same manual hint.
 */
async function offerBackgroundDaemon(io: ProgramIO, helpers: OnboardHelpers): Promise<void> {
  const plat = helpers.platform ?? process.platform;
  if (plat !== "darwin" && plat !== "win32") {
    io.stdout(`\n${BACKGROUND_INSTALL_HINT}`);
    return;
  }
  const wantsBackground = await (helpers.confirm ?? defaultConfirmBackgroundDaemon)(
    "Keep Muse running in the background (reminders, briefings, schedules)? 백그라운드 상시 실행할까요?"
  );
  if (!wantsBackground) {
    io.stdout(`\n${BACKGROUND_INSTALL_HINT}`);
    return;
  }
  try {
    const result = await installDaemonAutostart(io, process.env, {
      ...(helpers.daemonCliEntry !== undefined ? { daemonCliEntry: helpers.daemonCliEntry } : {}),
      ...(helpers.daemonTemporaryRoots ? { daemonTemporaryRoots: helpers.daemonTemporaryRoots } : {}),
      platform: plat,
      ...(helpers.runLaunchctl ? { runLaunchctl: helpers.runLaunchctl } : {}),
      ...(helpers.schtasksRun ? { schtasksRun: helpers.schtasksRun } : {})
    });
    if (!result.ok) io.stdout(`\n${BACKGROUND_INSTALL_HINT}`);
  } catch {
    io.stdout(`\n${BACKGROUND_INSTALL_HINT}`);
  }
}

const NOTIFICATIONS_LOG_HINT = "Proactive notices go to ~/.muse/notifications.log by default — `muse daemon --provider macos-notification` switches to native popups any time.\n";

async function defaultConfirmNotifications(message: string): Promise<boolean> {
  if (isNoInput() || !process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({ initialValue: false, message });
  return isCancel(answer) ? false : answer === true;
}

/**
 * A macOS-only offer, asked after the background-daemon offer: switch
 * proactive notices from the always-on log file to a native macOS popup.
 * Every other platform (or a "no"/cancelled answer) gets the one-line
 * pointer to the log file instead. Fail-soft: a config-write failure
 * never fails `muse onboard` — it just falls back to the same hint.
 */
async function offerNativeNotifications(io: ProgramIO, helpers: OnboardHelpers): Promise<void> {
  const plat = helpers.platform ?? process.platform;
  if (plat !== "darwin") {
    io.stdout(NOTIFICATIONS_LOG_HINT);
    return;
  }
  const wantsNotifications = await (helpers.confirmNotifications ?? defaultConfirmNotifications)(
    "Use native macOS notification popups for Muse's proactive notices? 네이티브 macOS 알림을 사용할까요?"
  );
  if (!wantsNotifications) {
    io.stdout(NOTIFICATIONS_LOG_HINT);
    return;
  }
  try {
    const configFile = resolveDaemonConfigFile(process.env);
    const existing = readDaemonConfig(configFile);
    writeDaemonConfig(configFile, {
      ...existing,
      destination: existing.destination ?? "@me",
      provider: "macos-notification"
    });
    io.stdout("Native notifications enabled — `muse daemon` will pop up macOS notifications for proactive notices.\n");
  } catch {
    io.stdout(NOTIFICATIONS_LOG_HINT);
  }
}

/**
 * Non-interactive (`--no-input`, no TTY, or piped) takes `defaultLang`
 * — already `config.language` if previously chosen, else the OS-locale
 * auto-detect — without prompting, so a scripted/CI `muse onboard` can
 * never hang on this question. This inline bilingual phrasing (한국어 ·
 * English side by side) is the one place that format survives post-E4a
 * — every OTHER onboarding string stays English-only; it's the language
 * question ITSELF that can't yet be rendered in the language it's asking
 * about.
 */
async function defaultSelectLanguage(defaultLang: Lang): Promise<Lang | undefined> {
  if (isNoInput() || !process.stdin.isTTY || !process.stdout.isTTY) return defaultLang;
  const { select, isCancel } = await import("@clack/prompts");
  const answer = await select({
    initialValue: defaultLang,
    message: "언어를 선택하세요 · Choose your language",
    options: [
      { label: "한국어", value: "ko" as const },
      { label: "English", value: "en" as const }
    ]
  });
  return isCancel(answer) ? undefined : answer;
}

/** AC1's FIRST interactive question. The chosen language persists to `config.json` so every later command's `resolveCliLanguage` picks it up without re-asking. */
async function selectLanguageStep(io: ProgramIO, helpers: OnboardHelpers): Promise<void> {
  const config = await readConfigStore(io);
  const defaultLang = config.language ?? detectLangFromLocale(process.env);
  const answer = await (helpers.selectLanguage ?? defaultSelectLanguage)(defaultLang);
  if (answer && answer !== config.language) {
    await writeConfigStore(io, { ...config, language: answer });
  }
}

export function registerOnboardCommand(program: Command, io: ProgramIO, helpers: OnboardHelpers = {}): void {
  program
    .command("onboard")
    .description("Guided setup: the single next step to your first private, cited answer")
    .option("--json", "Print the raw readiness report")
    .action(async (options: { readonly json?: boolean }) => {
      await selectLanguageStep(io, helpers);
      const report = computeOnboarding(await gatherState(io));
      if (options.json) {
        io.stdout(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      io.stdout("Muse — local, private, cited. Let's get you to your first answer.\n\n");
      for (const step of report.steps) {
        io.stdout(`${step.status === "ok" ? "✓" : "→"} ${step.title}\n   ${step.detail}\n`);
        if (step.command) io.stdout(`   $ ${step.command}\n`);
      }
      io.stdout(report.ready
        ? `\n✅ Ready. Ask your own machine:\n   $ ${report.nextCommand}\n`
        : `\n👉 Next: ${report.nextTitle}\n   $ ${report.nextCommand}\n`);
      if (report.dataHint) {
        io.stdout(`\n💡 ${report.dataHint.detail}\n   $ ${report.dataHint.command}\n`);
      }
      io.stdout("\nVerify your setup any time (models, local-only posture, index):\n   $ muse doctor --local\n");
      io.stdout("\nSchedule a recurring prompt: `muse scheduler add \"...\" --every \"daily 9am\"`\n");
      await offerBackgroundDaemon(io, helpers);
      await offerNativeNotifications(io, helpers);
    });
}
