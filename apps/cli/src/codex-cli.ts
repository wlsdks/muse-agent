/**
 * Codex delegation — talk to OpenAI's ChatGPT models through the user's OWN
 * official `codex` CLI login, never through a Muse-held token.
 *
 * This is an UNOFFICIAL third-party route (the same shape OpenClaw / Hermes
 * use): Muse shells out to the official `codex` binary, which owns the OAuth
 * session under `~/.codex/auth.json`. Muse never sees or stores the ChatGPT
 * credential — that is the whole point of delegating to the vendor's own CLI.
 *
 * The pieces:
 *   1. `detectCodexReadiness` — is the official CLI installed AND logged in?
 *      Deterministic, injectable (no live account needed to unit-test).
 *   2. `runCodexExec` — the subprocess bridge. Delegates to the SINGLE shared
 *      safe-invocation helper (`runCodexExecSafe` in `@muse/model`, which the
 *      `CodexCliProvider` also uses) so the CLI and the model adapter never
 *      drift on argv / sandbox flags / output extraction.
 *   3. `resolveCodexActivation` / `applyCodexModelToEnv` — OFF-by-default
 *      opt-in routing: when the user recorded a delegation choice AND the CLI
 *      is ready, pin the effective model to `codex/<model>`; otherwise leave
 *      the local default. Readiness (not a frozen `live` flag) is the truth.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CODEX_DEFAULT_MODEL_ID, CODEX_PROVIDER_ID, runCodexExecSafe } from "@muse/model";

export interface CodexReadiness {
  /** `codex` resolves on PATH. */
  readonly cliOnPath: boolean;
  /** Absolute path the CLI resolved to, when found. */
  readonly cliPath?: string;
  /** The official CLI has a logged-in session (`~/.codex/auth.json` exists). */
  readonly loggedIn: boolean;
  /** Auth file we probed — surfaced so the guidance can name the exact path. */
  readonly authFile: string;
  /** Both halves true — Muse may delegate. */
  readonly ready: boolean;
}

export interface CodexDetectDeps {
  readonly home?: string;
  readonly fileExists?: (path: string) => boolean;
  /** Resolve a command on PATH; returns its path or `undefined`. Injectable for tests. */
  readonly which?: (command: string) => Promise<string | undefined>;
}

async function defaultWhich(command: string): Promise<string | undefined> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const result = await execFile(finder, [command], { encoding: "utf8" });
    const first = String(result.stdout).split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
    return first;
  } catch {
    return undefined;
  }
}

/**
 * Is the official Codex CLI installed AND logged in? Pure detection — no live
 * account, no network. `~/.codex/auth.json` is where the official CLI writes
 * its session after `codex login`; its presence is our logged-in signal.
 */
export async function detectCodexReadiness(deps: CodexDetectDeps = {}): Promise<CodexReadiness> {
  const home = deps.home ?? homedir();
  const fileExists = deps.fileExists ?? existsSync;
  const which = deps.which ?? defaultWhich;
  const authFile = join(home, ".codex", "auth.json");
  const cliPath = await which("codex");
  const cliOnPath = Boolean(cliPath);
  const loggedIn = fileExists(authFile);
  return {
    authFile,
    cliOnPath,
    ...(cliPath ? { cliPath } : {}),
    loggedIn,
    ready: cliOnPath && loggedIn
  };
}

/** The exact steps to show when Codex isn't ready — never half-configure. */
export function codexSetupSteps(readiness: CodexReadiness): string {
  const steps: string[] = [];
  if (!readiness.cliOnPath) {
    steps.push("1. Install the official Codex CLI:  npm i -g @openai/codex   (or: brew install codex)");
  }
  if (!readiness.loggedIn) {
    steps.push(`${readiness.cliOnPath ? "1" : "2"}. Log in with your ChatGPT Plus/Pro account:  codex login`);
  }
  steps.push(`${steps.length + 1}. Re-run:  muse setup start`);
  return steps.join("\n");
}

export interface CodexExecResult {
  /** Process exited 0 with usable stdout. */
  readonly ok: boolean;
  /** Captured stdout (trimmed). */
  readonly text: string;
  readonly exitCode: number | null;
  readonly stderr: string;
}

export type SpawnLike = typeof spawn;

export interface CodexExecDeps {
  readonly spawn?: SpawnLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Model id to pass via `-m` (e.g. `"gpt-5.1"`); omitted ⇒ codex default. */
  readonly model?: string;
}

/**
 * Subprocess bridge: run one non-interactive completion through the official
 * `codex exec` and return the final assistant message. Delegates to the SINGLE
 * shared safe-invocation helper (`runCodexExecSafe` in `@muse/model`) so the CLI
 * and the `CodexCliProvider` never drift on argv / sandbox flags / extraction —
 * `--skip-git-repo-check --ephemeral -s read-only -C <neutral tmp> -o <out>`. A
 * failure (missing CLI, not-logged-in, non-zero exit) surfaces as `ok:false`
 * with the helper's diagnostic message in `stderr`.
 */
export async function runCodexExec(prompt: string, deps: CodexExecDeps = {}): Promise<CodexExecResult> {
  try {
    const result = await runCodexExecSafe(prompt, {
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.model ? { model: deps.model } : {})
    });
    return { exitCode: result.exitCode, ok: true, stderr: result.stderr, text: result.output };
  } catch (error) {
    return { exitCode: null, ok: false, stderr: error instanceof Error ? error.message : String(error), text: "" };
  }
}

export interface CodexDelegationConfig {
  readonly provider: "codex";
  readonly delegated: true;
  readonly configuredAt: string;
  /**
   * Optional pinned model id (e.g. `"gpt-5.1"`). Absent ⇒ the codex CLI's own
   * default (no `-m`). Whether delegation is LIVE is NOT frozen in this file —
   * `detectCodexReadiness().ready` (CLI installed + logged in) is the truth, so
   * a recorded choice auto-activates the moment the CLI is ready and falls back
   * to the local default when it is not.
   */
  readonly model?: string;
}

export function codexConfigPath(home: string): string {
  return join(home, ".muse", "codex.json");
}

/**
 * Record the user's CHOICE to delegate to their own codex CLI. Presence of this
 * file + live readiness (`detectCodexReadiness`) is what activates routing — the
 * file no longer freezes a `live` flag. Muse never stores the ChatGPT token; the
 * codex CLI owns auth.
 */
export async function writeCodexDelegationConfig(home: string, now: Date = new Date(), model?: string): Promise<string> {
  const file = codexConfigPath(home);
  await mkdir(dirname(file), { recursive: true });
  const config: CodexDelegationConfig = {
    configuredAt: now.toISOString(),
    delegated: true,
    provider: "codex",
    ...(model ? { model } : {})
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function readCodexDelegationConfig(home: string): Promise<CodexDelegationConfig | undefined> {
  try {
    const raw = await readFile(codexConfigPath(home), "utf8");
    const parsed = JSON.parse(raw) as Partial<CodexDelegationConfig>;
    if (parsed.provider === "codex" && parsed.delegated === true) {
      return {
        configuredAt: typeof parsed.configuredAt === "string" ? parsed.configuredAt : "",
        delegated: true,
        provider: "codex",
        ...(typeof parsed.model === "string" && parsed.model.length > 0 ? { model: parsed.model } : {})
      };
    }
  } catch {
    // missing / malformed → not delegated
  }
  return undefined;
}

export interface CodexActivation {
  /** Delegation is recorded AND the codex CLI is installed + logged in. */
  readonly active: boolean;
  /** Delegation is recorded (regardless of readiness). */
  readonly configured: boolean;
  readonly readiness: CodexReadiness;
  /** The `codex/<model>` id to route the effective model to — only when active. */
  readonly model?: string;
  /** Setup guidance to surface when configured but NOT ready. */
  readonly setupSteps?: string;
}

export interface CodexActivationDeps {
  readonly home?: string;
  readonly readConfig?: (home: string) => Promise<CodexDelegationConfig | undefined>;
  readonly detect?: (home: string) => Promise<CodexReadiness>;
}

/**
 * Resolve whether codex delegation should route THIS session, and to which
 * model. OFF by default: returns `undefined` when the user never opted in (no
 * `~/.muse/codex.json`), so the local default is untouched. When configured,
 * readiness is the truth — `active` iff the official CLI is installed + logged
 * in; otherwise `active:false` + `setupSteps` and the caller falls back to the
 * normal default. Pure/injectable so the gating is unit-testable without a live
 * account.
 */
export async function resolveCodexActivation(deps: CodexActivationDeps = {}): Promise<CodexActivation | undefined> {
  const home = deps.home ?? homedir();
  const readConfig = deps.readConfig ?? readCodexDelegationConfig;
  const detect = deps.detect ?? ((h: string) => detectCodexReadiness({ home: h }));
  const config = await readConfig(home);
  if (!config) {
    return undefined;
  }
  const readiness = await detect(home);
  if (!readiness.ready) {
    return { active: false, configured: true, readiness, setupSteps: codexSetupSteps(readiness) };
  }
  return {
    active: true,
    configured: true,
    model: `${CODEX_PROVIDER_ID}/${config.model ?? CODEX_DEFAULT_MODEL_ID}`,
    readiness
  };
}

/**
 * Apply an active codex routing decision to a mutable env map: pin `MUSE_MODEL`
 * to the `codex/<model>` id and force the provider id so `createModelProvider`
 * builds the `CodexCliProvider`. Only mutates when NOT already pinned (an
 * explicit `MUSE_MODEL` / `--model` wins). Returns the model it routed to, or
 * `undefined` when it left env unchanged.
 */
export function applyCodexModelToEnv(
  env: { MUSE_MODEL?: string; MUSE_MODEL_PROVIDER_ID?: string },
  model: string
): string | undefined {
  if (typeof env.MUSE_MODEL === "string" && env.MUSE_MODEL.trim().length > 0) {
    return undefined;
  }
  env.MUSE_MODEL = model;
  env.MUSE_MODEL_PROVIDER_ID = CODEX_PROVIDER_ID;
  return model;
}
