/**
 * Codex delegation — talk to OpenAI's ChatGPT models through the user's OWN
 * official `codex` CLI login, never through a Muse-held token.
 *
 * This is an UNOFFICIAL third-party route (the same shape OpenClaw / Hermes
 * use): Muse shells out to the official `codex` binary, which owns the OAuth
 * session under `~/.codex/auth.json`. Muse never sees or stores the ChatGPT
 * credential — that is the whole point of delegating to the vendor's own CLI.
 *
 * Two halves live here:
 *   1. `detectCodexReadiness` — is the official CLI installed AND logged in?
 *      Deterministic, injectable (no live account needed to unit-test).
 *   2. `runCodexExec` — the subprocess bridge SCAFFOLD. It spawns
 *      `codex exec <prompt>` and returns stdout. The spawn is injectable so
 *      the contract (args, stdout capture, exit handling) is unit-tested with
 *      a fake child. The REAL end-to-end round-trip needs the owner's live
 *      ChatGPT subscription — that path is NOT verified here and is gated by
 *      `CodexDelegationConfig.live === false` until it is.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

function defaultWhich(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    let out = "";
    const child = spawn(finder, [command], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      const first = out.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
      resolve(code === 0 && first ? first : undefined);
    });
  });
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
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * Subprocess bridge SCAFFOLD: run one non-interactive completion through the
 * official `codex exec` command and return its stdout. `spawn` is injectable
 * so the arg contract + stdout capture + exit handling are unit-tested with a
 * fake child (no live subscription). The live round-trip and any richer
 * stdout parsing (`codex exec --json`) are the flagged TODO — do not treat a
 * green unit test here as proof the live path works.
 */
export async function runCodexExec(prompt: string, deps: CodexExecDeps = {}): Promise<CodexExecResult> {
  const spawnImpl = deps.spawn ?? spawn;
  return new Promise((resolve) => {
    const child = spawnImpl("codex", ["exec", prompt], {
      cwd: deps.cwd,
      env: deps.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = deps.timeoutMs && deps.timeoutMs > 0
      ? setTimeout(() => {
        child.kill("SIGKILL");
      }, deps.timeoutMs)
      : undefined;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, ok: false, stderr: String(error.message), text: "" });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, ok: code === 0, stderr: stderr.trim(), text: stdout.trim() });
    });
  });
}

export interface CodexDelegationConfig {
  readonly provider: "codex";
  readonly delegated: true;
  /** Live routing is NOT verified against a real subscription yet — gate on this. */
  readonly live: false;
  readonly configuredAt: string;
}

export function codexConfigPath(home: string): string {
  return join(home, ".muse", "codex.json");
}

/**
 * Mark Muse as codex-delegated. `live: false` is deliberate and honest — the
 * config records the user's CHOICE and readiness, but the runtime model bridge
 * is still preview until verified against a live subscription.
 */
export async function writeCodexDelegationConfig(home: string, now: Date = new Date()): Promise<string> {
  const file = codexConfigPath(home);
  await mkdir(dirname(file), { recursive: true });
  const config: CodexDelegationConfig = {
    configuredAt: now.toISOString(),
    delegated: true,
    live: false,
    provider: "codex"
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
        live: false,
        provider: "codex"
      };
    }
  } catch {
    // missing / malformed → not delegated
  }
  return undefined;
}
