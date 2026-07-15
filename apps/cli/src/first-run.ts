/**
 * First-run setup wizard — install → run `muse` → a warm, branded "how should
 * Muse think?" onboarding (the bluebird + MUSE wordmark, a designed provider
 * picker, a bird success moment), instead of dropping a brand-new user straight
 * into chat. Bilingual KO · EN throughout.
 *
 * Two concerns live here:
 *   1. DETECTION (`shouldRunFirstRunSetup`) — pure, so the auto-launch guard is
 *      testable and can never hijack a non-interactive / test run. It fires
 *      ONLY on an interactive TTY, when no model is configured (config or env),
 *      no provider key is present, and the once-only marker is absent.
 *   2. The WIZARD (`runFirstRunWizard`) — a provider picker (Local / Cloud /
 *      Codex) that reuses the existing setup wiring (`planCloudSetup`,
 *      `persistModelProviderKey`, `detectCodexReadiness`). Prompt + IO seams are
 *      injected so the picker → config flow is unit-tested without a real TTY;
 *      the visuals (banner, bird, colour) live in the production adapter and are
 *      NO_COLOR / non-TTY / reduced-motion safe.
 *
 * Fail-soft is the contract: any error or declined step writes the marker and
 * returns — the caller falls back into chat on the local default. Nothing here
 * forces cloud; Local stays pre-selected and recommended.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_FIRST_DEFAULT_MODEL } from "@muse/autoconfigure";
import { isRecord } from "@muse/shared";

import { CLOUD_PROVIDERS, planCloudSetup } from "./commands-setup-cloud.js";
import { runDataSetupInFlagMode, type DataSetupFlags, type DataSetupResult } from "./commands-setup-data.js";
import { resolveSkillsDir } from "./commands-skills.js";
import {
  buildFirstValueLine,
  dataFlagsFromSelection,
  FIRST_RUN_DATA_MESSAGE,
  FIRST_RUN_DATA_OPTIONS,
  firstValueContextFromDataResult,
  nextStepsHint,
  NEXT_STEPS_NOTE_TITLE,
  scaffoldStarterSkillsIfEmpty,
  smartDefaultsNote,
  type FirstValueContext
} from "./first-run-value.js";
import {
  codexSetupSteps,
  detectCodexReadiness,
  writeCodexDelegationConfig,
  type CodexReadiness
} from "./codex-cli.js";
import { renderMuseBanner } from "./muse-banner.js";
import { MUSE_BIRD_ANSI } from "./muse-mascot.js";
import { persistModelProviderKey } from "./setup-model.js";
import { colorAllowed, colorize } from "./tty-color.js";
import { probeOllamaModels } from "./ollama-probe.js";

/** Any of these in the env means a provider is already wired — skip first-run. */
export const PROVIDER_KEY_ENV_VARS: readonly string[] = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "CEREBRAS_API_KEY"
];

export function providerKeyPresent(env: NodeJS.ProcessEnv): boolean {
  return PROVIDER_KEY_ENV_VARS.some((key) => (env[key] ?? "").trim().length > 0);
}

function truthy(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * True when the auto-launch must be BYPASSED regardless of setup state:
 * an explicit opt-out, OR any non-interactive / test context. Vitest, CI and
 * `NODE_ENV=test` are hard-coded here so the suite can never trip the wizard.
 */
export function firstRunSkipRequested(env: NodeJS.ProcessEnv, noSetupFlag = false): boolean {
  if (noSetupFlag) return true;
  if (truthy(env.MUSE_SKIP_FIRST_RUN)) return true;
  if (truthy(env.VITEST) || env.VITEST_WORKER_ID !== undefined) return true;
  if (truthy(env.CI)) return true;
  if (env.NODE_ENV === "test") return true;
  return false;
}

export interface FirstRunSignals {
  readonly interactive: boolean;
  readonly markerPresent: boolean;
  readonly configuredModel?: string;
  readonly envModel?: string;
  readonly providerKeyPresent: boolean;
  readonly skipRequested: boolean;
}

/**
 * Pure decision: should the first-run wizard auto-launch? Every "already set
 * up" signal (a configured model in config OR env, a provider key, the marker)
 * suppresses it, as does any non-interactive / opt-out context.
 */
export function shouldRunFirstRunSetup(signals: FirstRunSignals): boolean {
  if (!signals.interactive) return false;
  if (signals.skipRequested) return false;
  if (signals.markerPresent) return false;
  if ((signals.configuredModel ?? "").trim().length > 0) return false;
  if ((signals.envModel ?? "").trim().length > 0) return false;
  if (signals.providerKeyPresent) return false;
  return true;
}

export function firstRunMarkerPath(home: string): string {
  return join(home, ".muse", "first-run.json");
}

export function isFirstRunMarkerPresent(home: string): boolean {
  return existsSync(firstRunMarkerPath(home));
}

export async function writeFirstRunMarker(home: string, choice: string, now: Date = new Date()): Promise<string> {
  const file = firstRunMarkerPath(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ choice, completedAt: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export const CODEX_HONEST_COPY =
  "Codex는 내 ChatGPT 구독을 공식 `codex` 로그인으로 사용해요. Muse는 OAuth 토큰을 절대 다루지 않아요 —\n" +
  "인증은 공식 codex CLI가 갖고, Muse는 그 위에서 실행만 위임해요.\n" +
  "Codex uses your OWN ChatGPT subscription via the official `codex` login. Muse never handles the\n" +
  "token — the codex CLI owns auth; Muse just shells out to it.\n\n" +
  "참고 · 이건 비공식 제3자 경로예요 (OpenClaw / Hermes 류). OpenAI가 임의의 제3자 클라이언트를 문서로\n" +
  "승인한 적은 없어요 — 동작하고 개인용은 위험이 낮지만, 선택은 본인 몫이에요. 가장 깔끔한 길은 클라우드 API 키.\n" +
  "Heads up · this is an UNOFFICIAL third-party route. Personal use is low-risk, but it's your\n" +
  "call — the clean, no-ambiguity path is a Cloud API key.";

/** Warm one-liner shown in the branded intro bar (KO · EN). */
export const FIRST_RUN_INTRO = "반가워요 — Muse를 어떻게 쓸지 30초면 정해요  ·  Welcome — let's set up Muse in ~30s";

/** Total major steps in the first-run wizard — every step header derives its `N` from this, so the numbering can't silently drift. */
export const TOTAL_FIRST_RUN_STEPS = 3;

/**
 * ONE consistent step-header format for every major wizard step (KO · EN), so the
 * steps read as distinct, labeled blocks instead of one undifferentiated clack
 * scroll — and can't regress to an unlabeled list. `N / total · <ko>   ·   <en>`.
 */
export function stepHeader(n: number, total: number, ko: string, en: string): string {
  return `${n.toString()} / ${total.toString()} · ${ko}   ·   ${en}`;
}

/**
 * The three MAJOR steps every successful branch walks, pinned so the step framing
 * can't regress: 1 = model pick, 2 = connect data, 3 = finishing up. Rendered as a
 * ruled divider before each step by the `step` seam (`renderStepDivider`).
 */
export const FIRST_RUN_STEP_HEADERS = {
  data: stepHeader(2, TOTAL_FIRST_RUN_STEPS, "연결할 데이터", "Connect your data"),
  finish: stepHeader(3, TOTAL_FIRST_RUN_STEPS, "마무리", "Finishing up"),
  pick: stepHeader(1, TOTAL_FIRST_RUN_STEPS, "어떻게 생각하게 할까요?", "How should Muse think?")
} as const;

/** The provider picker's instruction line — the step number lives in the step-1 divider above it (KO · EN). */
export const FIRST_RUN_PICK_MESSAGE = "하나 고르세요 — 로컬이 안전한 기본값   ·   Pick one — Local is the safe default";

export type FirstRunChoice = "local" | "cloud" | "codex" | "skip";

/**
 * The designed provider options — a bilingual titled line + a short dim
 * subtitle each, Local first (pre-selected). Exported so the premium copy is
 * pinned by a test and can't silently regress to a plain list.
 */
export const FIRST_RUN_PROVIDER_OPTIONS: readonly {
  readonly value: Exclude<FirstRunChoice, "skip">;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    hint: "내 Mac에서 직접 실행 · 아무것도 밖으로 안 나가요 · most private",
    label: "🔒 로컬 (Ollama) — 추천   ·   Local (recommended)",
    value: "local"
  },
  {
    hint: "API 키로 강력한 클라우드 모델 · Gemini / OpenAI / Anthropic / OpenRouter",
    label: "☁️  클라우드 (API 키)   ·   Cloud (API key)",
    value: "cloud"
  },
  {
    hint: "공식 codex CLI에 위임 · 비공식 경로 · uses your own ChatGPT login",
    label: "✨ Codex (내 ChatGPT 구독)   ·   Codex (your ChatGPT sub)",
    value: "codex"
  }
];

export interface FirstRunPrompts {
  select<T>(options: {
    readonly message: string;
    readonly initialValue?: T;
    readonly options: readonly { readonly value: T; readonly label: string; readonly hint?: string }[];
  }): Promise<T | symbol>;
  multiselect?<T>(options: {
    readonly message: string;
    readonly required?: boolean;
    readonly options: readonly { readonly value: T; readonly label: string; readonly hint?: string }[];
  }): Promise<T[] | symbol>;
  password?(options: { readonly message: string }): Promise<string | symbol>;
  confirm?(options: { readonly message: string; readonly initialValue?: boolean }): Promise<boolean | symbol>;
  isCancel(value: unknown): value is symbol;
  note?(message: string, title?: string): void;
  intro?(message: string): void;
  outro?(message: string): void;
  /** Render a labeled step divider (a ruled block) so each step reads as its own section. */
  step?(header: string): void;
}

export interface FirstRunWizardDeps {
  readonly prompts: FirstRunPrompts;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly readConfig: () => Promise<{ readonly apiUrl?: string; readonly defaultModel?: string }>;
  readonly writeConfig: (config: { readonly apiUrl?: string; readonly defaultModel?: string }) => Promise<void>;
  readonly detectCodex?: () => Promise<CodexReadiness>;
  readonly writeCodexConfig?: (home: string) => Promise<string>;
  readonly persistCloudKey?: (providerId: string, token: string, suggestedModel: string) => Promise<string>;
  readonly writeMarker?: (home: string, choice: string) => Promise<string>;
  /** Optional local readiness probe (Ollama reachable? model pulled?) for a friendlier note. */
  readonly probeLocal?: () => Promise<{ readonly reachable: boolean; readonly detail: string }>;
  /** Optional finale flourish (bird + check) printed on a successful config path. */
  readonly celebrate?: () => void;
  /**
   * Optional "connect your data" runner — routes the chosen connectors through
   * the existing `muse setup data` flag-mode path. Absent ⇒ the data-connect
   * step is skipped (tests / non-interactive).
   */
  readonly runDataConnect?: (flags: DataSetupFlags) => Promise<DataSetupResult>;
  /** Optional smart-defaults applier (scaffold starter skills, etc.); returns the count scaffolded. */
  readonly applyDefaults?: () => Promise<{ readonly skillsScaffolded: number }>;
  /** Optional identity read for a personalized first-value line (name if already known). */
  readonly readIdentity?: () => Promise<{ readonly name?: string }>;
}

export interface FirstRunResult {
  readonly choice: FirstRunChoice;
  readonly wroteDefaultModel?: string;
  readonly codexReady?: boolean;
  readonly cloudKeyStored?: boolean;
  readonly markerWritten: boolean;
  /** Connector ids the user connected during the data-connect step (empty when skipped). */
  readonly dataConnected?: readonly string[];
  /** Starter skills scaffolded by the smart-defaults step (0 when skipped / dir non-empty). */
  readonly skillsScaffolded?: number;
  /** Whether the shown first-value success line asserted a real user fact. */
  readonly firstValueGrounded?: boolean;
}

/**
 * The provider picker + branch logic. Deps-injected so the whole flow is
 * unit-testable without a TTY. Always writes the once-only marker on exit
 * (completed OR skipped) so the wizard never re-auto-shows.
 */
export async function runFirstRunWizard(deps: FirstRunWizardDeps): Promise<FirstRunResult> {
  const detectCodex = deps.detectCodex ?? (() => detectCodexReadiness({ home: deps.home }));
  const writeCodexConfig = deps.writeCodexConfig ?? writeCodexDelegationConfig;
  const persistCloudKey = deps.persistCloudKey
    ?? ((providerId, token, suggestedModel) => persistModelProviderKey(deps.home, providerId, token, suggestedModel));
  const writeMarker = deps.writeMarker ?? writeFirstRunMarker;

  const finish = async (result: Omit<FirstRunResult, "markerWritten">): Promise<FirstRunResult> => {
    await writeMarker(deps.home, result.choice);
    return { ...result, markerWritten: true };
  };

  try {
    return await runFirstRunWizardBody(deps, { detectCodex, finish, persistCloudKey, writeCodexConfig });
  } catch {
    // Fail-soft: a wizard error must never brick `muse`. Mark done so it
    // doesn't re-auto-show, and let the caller fall back into chat.
    try {
      await writeMarker(deps.home, "error");
    } catch {
      // ignore
    }
    return { choice: "skip", markerWritten: true };
  }
}

interface WizardHelpers {
  readonly detectCodex: () => Promise<CodexReadiness>;
  readonly writeCodexConfig: (home: string) => Promise<string>;
  readonly persistCloudKey: (providerId: string, token: string, suggestedModel: string) => Promise<string>;
  readonly finish: (result: Omit<FirstRunResult, "markerWritten">) => Promise<FirstRunResult>;
}

async function runFirstRunWizardBody(deps: FirstRunWizardDeps, helpers: WizardHelpers): Promise<FirstRunResult> {
  const { prompts } = deps;
  const { detectCodex, finish, persistCloudKey, writeCodexConfig } = helpers;

  prompts.intro?.(FIRST_RUN_INTRO);

  prompts.step?.(FIRST_RUN_STEP_HEADERS.pick);
  const choice = await prompts.select<FirstRunChoice>({
    initialValue: "local",
    message: FIRST_RUN_PICK_MESSAGE,
    options: FIRST_RUN_PROVIDER_OPTIONS.map((option) => ({ hint: option.hint, label: option.label, value: option.value }))
  });

  if (prompts.isCancel(choice)) {
    prompts.outro?.("괜찮아요 — 로컬 기본값으로 시작할게요. 언제든 `muse setup` 으로 바꿀 수 있어요.  ·  No problem — starting on the local default.");
    return finish({ choice: "skip" });
  }

  if (choice === "local") {
    const model = LOCAL_FIRST_DEFAULT_MODEL;
    const config = await deps.readConfig();
    await deps.writeConfig({ ...config, defaultModel: model });
    const head = `Muse는 로컬 ${model} 에서 생각해요  ·  thinking locally on ${model}.`;
    let tail = "";
    if (deps.probeLocal) {
      const probe = await deps.probeLocal();
      tail = probe.reachable
        ? `\nOllama 준비됨 · ready. ${probe.detail}`
        : `\nOllama가 아직 안 켜졌어요 — 설치하고 모델을 받아주세요 · install it and pull the model:\n  brew install ollama && ollama serve\n  ollama pull ${model.replace(/^ollama\//u, "")}\n\n${probe.detail}`;
    }
    prompts.note?.(`${head}${tail}`, "로컬 · Local");
    return finishWithValue(deps, helpers, { choice: "local", wroteDefaultModel: model });
  }

  if (choice === "cloud") {
    const providerId = await prompts.select<string>({
      message: "어떤 클라우드 제공자? (모두 공식 · BYO 키)   ·   Which cloud provider? (all official, BYO key)",
      options: CLOUD_PROVIDERS.map((p) => ({ label: p.label, value: p.id }))
    });
    if (prompts.isCancel(providerId)) {
      prompts.outro?.("건너뛰었어요 — 로컬 기본값으로 시작할게요.  ·  Skipped — starting on the local default.");
      return finish({ choice: "skip" });
    }
    const plan = planCloudSetup(providerId, deps.env);
    if (!plan) {
      prompts.note?.(`알 수 없는 제공자 '${providerId}'. 나중에 \`muse setup cloud --provider <id>\` 를 실행하세요.`, "클라우드 · Cloud");
      return finish({ choice: "skip" });
    }
    const config = await deps.readConfig();
    await deps.writeConfig({ ...config, defaultModel: plan.defaultModel });

    let cloudKeyStored = false;
    if (prompts.password) {
      const entered = await prompts.password({ message: `${plan.provider.keyEnvVars[0]} (키를 붙여넣거나, 비워두면 나중에 · paste key or leave blank):` });
      if (!prompts.isCancel(entered) && String(entered).trim().length > 0) {
        await persistCloudKey(providerId, String(entered).trim(), plan.defaultModel);
        cloudKeyStored = true;
      }
    }

    prompts.note?.(cloudKeyStored
      ? `${plan.provider.label} 키를 ~/.muse/models.json (chmod 600)에 저장했어요. Muse는 ${plan.defaultModel} 를 써요.\nSaved your ${plan.provider.label} key — Muse will use ${plan.defaultModel}.`
      : `Muse를 ${plan.provider.label} (${plan.defaultModel})로 설정했어요. 마치려면 셸에서 키를 설정하세요 · to finish, export your key:\n  ${plan.requiredExports.join("\n  ")}`,
    "클라우드 · Cloud");
    return finishWithValue(deps, helpers, { choice: "cloud", cloudKeyStored, wroteDefaultModel: plan.defaultModel });
  }

  // choice === "codex"
  prompts.note?.(CODEX_HONEST_COPY, "Codex — 먼저 읽어주세요 · read this first");
  const readiness = await detectCodex();
  if (!readiness.ready) {
    prompts.note?.(codexSetupSteps(readiness), "Codex 아직 준비 안 됨 · not ready yet");
    prompts.outro?.("지금은 로컬 기본값으로 시작할게요 — `codex login` 후 `muse setup start` 를 다시 실행하세요.  ·  Starting local; re-run after `codex login`.");
    return finish({ choice: "codex", codexReady: false });
  }

  const confirmed = prompts.confirm
    ? await prompts.confirm({ initialValue: false, message: "codex CLI 로 라우팅할까요? (로컬이 안전한 기본값)   ·   Route Muse through your codex CLI?" })
    : true;
  if (prompts.isCancel(confirmed) || confirmed === false) {
    prompts.outro?.("알겠어요 — 로컬 기본값으로 시작할게요.  ·  No worries — starting on the local default.");
    return finish({ choice: "codex", codexReady: true });
  }

  await writeCodexConfig(deps.home);
  prompts.note?.(
    "Codex 위임을 저장했어요. codex CLI가 준비된 동안(설치 + 로그인) Muse는 codex로 라우팅하고,\n" +
    "준비가 안 되면 자동으로 로컬 기본값으로 돌아가요. Muse는 ChatGPT 토큰을 저장하지 않아요 — 공식 codex CLI 소유.\n" +
    "Codex delegation saved. Muse routes through codex while the CLI is ready (installed + logged in),\n" +
    "and falls back to the local default when it isn't. Muse never stores the ChatGPT token.",
    "Codex 설정됨 · configured"
  );
  return finishWithValue(deps, helpers, { choice: "codex", codexReady: true });
}

/**
 * The shared "first value" tail every SUCCESSFUL provider branch routes through:
 * offer the data-connect step, apply smart defaults, show the "what next" hint
 * (`muse browsing sync` / `muse demo`), then the personalized first-value
 * success line + finale bird. Wholly fail-soft — any step error is swallowed
 * so a value-tail hiccup can never brick the wizard; the marker is still
 * written by `finish`.
 */
async function finishWithValue(
  deps: FirstRunWizardDeps,
  helpers: WizardHelpers,
  partial: Omit<FirstRunResult, "markerWritten" | "dataConnected" | "skillsScaffolded" | "firstValueGrounded">
): Promise<FirstRunResult> {
  const { prompts } = deps;
  let dataConnected: readonly string[] = [];
  let skillsScaffolded = 0;
  let firstValue = buildFirstValueLine({});

  try {
    const dc = await runDataConnectStep(deps);
    dataConnected = dc.chosen;
    prompts.step?.(FIRST_RUN_STEP_HEADERS.finish);
    skillsScaffolded = await applySmartDefaultsStep(deps);
    const identity: { readonly name?: string } = deps.readIdentity
      ? await deps.readIdentity().catch(() => ({}))
      : {};
    const fvCtx: FirstValueContext = {
      ...(identity.name ? { userName: identity.name } : {}),
      ...firstValueContextFromDataResult(dc.result)
    };
    firstValue = buildFirstValueLine(fvCtx);
    prompts.note?.(nextStepsHint(dataConnected), NEXT_STEPS_NOTE_TITLE);
  } catch {
    // fail-soft: never let the value tail brick `muse`.
  }

  deps.celebrate?.();
  prompts.outro?.(firstValue.line);
  return helpers.finish({ ...partial, dataConnected, firstValueGrounded: firstValue.grounded, skillsScaffolded });
}

/** Offer the data-connect multi-select and route the picks through `setup data`. Skips when unwired. */
async function runDataConnectStep(
  deps: FirstRunWizardDeps
): Promise<{ readonly chosen: readonly string[]; readonly result?: DataSetupResult }> {
  const { prompts } = deps;
  if (!deps.runDataConnect || !prompts.multiselect) return { chosen: [] };

  prompts.step?.(FIRST_RUN_STEP_HEADERS.data);
  const selected = await prompts.multiselect<string>({
    message: FIRST_RUN_DATA_MESSAGE,
    options: FIRST_RUN_DATA_OPTIONS.map((o) => ({ hint: o.hint, label: o.label, value: o.value })),
    required: false
  });
  if (prompts.isCancel(selected) || !Array.isArray(selected) || selected.length === 0) {
    prompts.note?.("나중에 언제든 `muse setup data` 로 연결할 수 있어요  ·  connect anytime with `muse setup data`.", "데이터 · Data");
    return { chosen: [] };
  }

  const flags = dataFlagsFromSelection(selected);
  const result = await deps.runDataConnect(flags);
  return { chosen: selected, result };
}

/** Apply the sensible defaults (scaffold starter skills, confirm auto-extract). Skips when unwired. */
async function applySmartDefaultsStep(deps: FirstRunWizardDeps): Promise<number> {
  if (!deps.applyDefaults) return 0;
  const { skillsScaffolded } = await deps.applyDefaults();
  deps.prompts.note?.(smartDefaultsNote(skillsScaffolded), "기본값 · Smart defaults");
  return skillsScaffolded;
}

export interface RunFirstRunInteractiveDeps {
  readonly readConfig: () => Promise<{ readonly apiUrl?: string; readonly defaultModel?: string }>;
  readonly writeConfig: (config: { readonly apiUrl?: string; readonly defaultModel?: string }) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * A step divider: a blank line + a ruled, bold step header, so each wizard step
 * reads as its own block instead of blending into the note-box scroll.
 * Colour/TTY-safe — under NO_COLOR / a pipe the ANSI is dropped and the plain
 * header prints between plain rules; no animation, so reduced-motion safe.
 */
function renderStepDivider(header: string): string {
  const rule = "─".repeat(52);
  if (colorAllowed()) {
    return `\n${colorize(rule, "dim")}\n${colorize(colorize(header, "cyan"), "bold")}\n${colorize(rule, "dim")}\n`;
  }
  return `\n${rule}\n${header}\n${rule}\n`;
}

/**
 * The finale flourish: the bluebird + a green check + a bilingual "all set"
 * line. Colour/TTY-safe — under NO_COLOR / a pipe the truecolour bird is
 * dropped (it would be escape-code noise) and only the plain check prints. No
 * animation, so it's reduced-motion safe by construction.
 */
function celebrateFirstRun(): void {
  const done = "✓ 다 됐어요 — Muse 시작할게요  ·  All set — starting Muse";
  if (colorAllowed()) {
    const bird = MUSE_BIRD_ANSI.split("\n").map((line) => `  ${line}`).join("\n");
    process.stdout.write(`\n${bird}\n  ${colorize(done, "green")}\n\n`);
  } else {
    process.stdout.write(`\n  ${done}\n\n`);
  }
}

/**
 * Production entry: build the real @clack prompt + IO seams and run the wizard.
 * Fail-soft — any thrown error is swallowed (marker best-effort written) so a
 * broken wizard can never brick `muse`; the caller drops into chat regardless.
 */
export async function runFirstRunSetupInteractive(deps: RunFirstRunInteractiveDeps): Promise<FirstRunResult | undefined> {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  try {
    // Open on the brand: the bluebird + MUSE wordmark, so first-run reads like a
    // real onboarding, not a bare prompt list. (Falls back to a plain wordmark
    // under NO_COLOR/pipe; the wizard only runs on an interactive TTY anyway.)
    process.stdout.write(`${renderMuseBanner({ status: "첫 실행 설정 · first-run setup", hint: "30초면 끝나요 · ~30s, change anytime with `muse setup`" })}\n`);
    const clack = await import("@clack/prompts");
    const prompts: FirstRunPrompts = {
      confirm: (options) => clack.confirm(options),
      intro: (message) => clack.intro(message),
      isCancel: (value) => clack.isCancel(value),
      multiselect: <T>(options) => clack.multiselect(options),
      note: (message, title) => clack.note(message, title),
      outro: (message) => clack.outro(message),
      password: (options) => clack.password(options),
      select: <T>(options) => clack.select(options),
      step: (header) => process.stdout.write(renderStepDivider(header))
    };
    const stdio = { stderr: (m: string) => process.stderr.write(m), stdout: (m: string) => process.stdout.write(m) };
    return await runFirstRunWizard({
      applyDefaults: async () => ({ skillsScaffolded: await scaffoldStarterSkillsIfEmpty(resolveSkillsDir(env)) }),
      celebrate: celebrateFirstRun,
      env,
      home,
      probeLocal: () => probeLocalOllama(env, deps.fetch),
      prompts,
      readConfig: deps.readConfig,
      readIdentity: () => readKnownUserName(env),
      runDataConnect: (flags) => runDataSetupInFlagMode(stdio, flags, env),
      writeConfig: deps.writeConfig
    });
  } catch {
    // Fail-soft: never brick `muse`. Best-effort mark so we don't loop the wizard.
    try {
      await writeFirstRunMarker(home, "error");
    } catch {
      // ignore
    }
    return undefined;
  }
}

async function probeLocalOllama(env: NodeJS.ProcessEnv, fetchImpl?: typeof globalThis.fetch): Promise<{ reachable: boolean; detail: string }> {
  const baseUrl = (env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/u, "");
  const { models, reachable } = await probeOllamaModels(baseUrl, {
    fetchImpl,
    timeoutMs: 2_000
  });
  if (reachable) {
    return { detail: `${models.length.toString()}개 모델 설치됨 · model(s) installed. Run \`muse onboard\` to finish.`, reachable: true };
  }
  return { detail: "그다음 `muse onboard` 로 마무리하세요 · then run `muse onboard`.", reachable: false };
}

/** Name-like fact keys the first-value line may greet by (best-effort). */
const NAME_FACT_KEYS: readonly string[] = ["name", "preferred_name", "full_name", "first_name", "이름"];

/**
 * Best-effort read of a known display name from the local user-memory store for
 * the personalized first-value line. On a fresh install there is none — returns
 * `{}` — so the line falls to a connected-source or content-free welcome. Never
 * throws (a missing / unreadable store is just "no name").
 */
async function readKnownUserName(env: NodeJS.ProcessEnv): Promise<{ name?: string }> {
  try {
    const userId = (env.MUSE_USER_ID ?? env.USER ?? "default").trim() || "default";
    const file = env.MUSE_USER_MEMORY_FILE?.trim() || join(homedir(), ".muse", "user-memory.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    const users = isRecord(raw) ? raw.users : undefined;
    const user = isRecord(users) ? users[userId] : undefined;
    const facts = isRecord(user) ? user.facts : undefined;
    const factsRecord = isRecord(facts) ? facts : {};
    for (const key of NAME_FACT_KEYS) {
      const value = factsRecord[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return { name: value.trim() };
      }
    }
  } catch {
    // no name available
  }
  return {};
}
