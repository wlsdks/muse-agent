/**
 * `muse remote` — serve the Muse web UI to your OWN devices over your
 * Tailscale tailnet, never the public internet. The API server already
 * serves the built web UI on one local port (default 3030); this command
 * turns that into a URL you can open on your phone.
 *
 *   muse remote status   — tailscale + serve + API-server + auth posture
 *   muse remote enable   — preflight, then `tailscale serve --bg <port>`
 *   muse remote disable  — `tailscale serve reset` (idempotent)
 *
 * Every tailscale invocation goes through the ONE injected `run` seam
 * (mirrors `UpdateCommandHelpers.run` in commands-update.ts) so a test can
 * prove the exact command sequence without ever touching the real
 * tailscaled daemon, and `defaultRemoteRunner` hard-refuses to exec for
 * real under vitest even if a test forgets to inject.
 *
 * Tailscale Funnel (public-internet exposure) is permanently out of scope:
 * the word "funnel" is never passed to `run`, and `--funnel` refuses before
 * any exec.
 *
 * Commands verified against the official docs (see the S6 WORKER handoff
 * notes for the exact URLs/snapshots):
 *   - https://tailscale.com/docs/features/tailscale-serve
 *   - https://tailscale.com/docs/reference/tailscale-cli/serve
 *   - https://tailscale.com/docs/reference/tailscale-cli (macOS App-Store CLI path)
 */

import { existsSync } from "node:fs";
import { platform } from "node:os";

import type { Command } from "commander";

import { runCommandWithTimeout } from "@muse/shared";

import { readApiOptions } from "./program-config.js";
import type { ProgramIO } from "./program.js";

const DETECT_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 8_000;
const SERVE_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;

/** App-Store variant of the macOS client bundles the CLI here (no /usr/local/bin symlink). */
const MACOS_APP_BUNDLE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const INSTALL_URLS: Readonly<Record<string, string>> = {
  darwin: "https://tailscale.com/download/mac",
  linux: "https://tailscale.com/download/linux",
  win32: "https://tailscale.com/download/windows"
};

export interface RemoteExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type RemoteRunner = (call: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<RemoteExecResult>;

function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

/**
 * Never reaches a real `tailscale` under vitest, even if a test forgets to
 * inject `RemoteCommandHelpers.run` — a real invocation would touch this
 * machine's actual tailscaled daemon and network state.
 */
export const defaultRemoteRunner: RemoteRunner = async ({ command, args, cwd, timeoutMs }) => {
  if (isRunningUnderVitest()) {
    throw new Error(
      `refusing to exec real '${command} ${args.join(" ")}' under vitest — inject RemoteCommandHelpers.run in this test`
    );
  }
  return runCommandWithTimeout({ command, args, cwd, timeoutMs });
};

export function installUrlForPlatform(osPlatform: NodeJS.Platform = platform()): string {
  return INSTALL_URLS[osPlatform] ?? "https://tailscale.com/download";
}

/**
 * Detects the `tailscale` binary with a harmless `version` probe: PATH
 * first, then (macOS only) the App-Store client's bundled CLI. Returns the
 * exact command string to use for every subsequent call, or `undefined`
 * when neither location works. This is the ONLY exec allowed before every
 * other preflight has passed.
 */
export async function resolveTailscaleBinary(deps: {
  readonly run: RemoteRunner;
  readonly cwd: string;
  readonly exists?: (path: string) => boolean;
  readonly osPlatform?: NodeJS.Platform;
}): Promise<string | undefined> {
  const exists = deps.exists ?? existsSync;
  const osPlatform = deps.osPlatform ?? platform();

  try {
    const result = await deps.run({ args: ["version"], command: "tailscale", cwd: deps.cwd, timeoutMs: DETECT_TIMEOUT_MS });
    if (result.exitCode === 0) return "tailscale";
  } catch {
    // fall through to the macOS app-bundle fallback
  }

  if (osPlatform === "darwin" && exists(MACOS_APP_BUNDLE_CLI)) {
    try {
      const result = await deps.run({
        args: ["version"],
        command: MACOS_APP_BUNDLE_CLI,
        cwd: deps.cwd,
        timeoutMs: DETECT_TIMEOUT_MS
      });
      if (result.exitCode === 0) return MACOS_APP_BUNDLE_CLI;
    } catch {
      // not installed there either
    }
  }

  return undefined;
}

export interface TailscaleSelfStatus {
  readonly backendState: string;
  readonly dnsName: string | undefined;
}

/** `tailscale status --json` → `ipnstate.Status` (BackendState + Self.DNSName, a trailing-dot FQDN). */
export function parseTailscaleStatusJson(raw: string): TailscaleSelfStatus | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      readonly BackendState?: unknown;
      readonly Self?: { readonly DNSName?: unknown };
    };
    const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : "NoState";
    const rawDnsName = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName : undefined;
    const dnsName = rawDnsName ? rawDnsName.replace(/\.$/u, "") : undefined;
    return { backendState, dnsName };
  } catch {
    return undefined;
  }
}

export interface TailscaleLoginStatus {
  readonly loggedIn: boolean;
  readonly backendState: string;
  readonly dnsName: string | undefined;
}

export async function checkTailscaleLogin(deps: {
  readonly run: RemoteRunner;
  readonly binary: string;
  readonly cwd: string;
}): Promise<TailscaleLoginStatus> {
  try {
    const result = await deps.run({
      args: ["status", "--json"],
      command: deps.binary,
      cwd: deps.cwd,
      timeoutMs: STATUS_TIMEOUT_MS
    });
    if (result.exitCode !== 0) return { backendState: "NoState", dnsName: undefined, loggedIn: false };
    const parsed = parseTailscaleStatusJson(result.stdout);
    if (!parsed) return { backendState: "NoState", dnsName: undefined, loggedIn: false };
    return { backendState: parsed.backendState, dnsName: parsed.dnsName, loggedIn: parsed.backendState === "Running" };
  } catch {
    return { backendState: "NoState", dnsName: undefined, loggedIn: false };
  }
}

/** `tailscale serve status --json` → `ipn.ServeConfig` (TCP / Web / Services, all `omitempty`). */
export function parseServeStatusJson(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      readonly TCP?: Readonly<Record<string, unknown>>;
      readonly Web?: Readonly<Record<string, unknown>>;
      readonly Services?: Readonly<Record<string, unknown>>;
    };
    return (
      Object.keys(parsed.TCP ?? {}).length > 0 ||
      Object.keys(parsed.Web ?? {}).length > 0 ||
      Object.keys(parsed.Services ?? {}).length > 0
    );
  } catch {
    return false;
  }
}

export async function checkServeActive(deps: {
  readonly run: RemoteRunner;
  readonly binary: string;
  readonly cwd: string;
}): Promise<boolean> {
  try {
    const result = await deps.run({
      args: ["serve", "status", "--json"],
      command: deps.binary,
      cwd: deps.cwd,
      timeoutMs: STATUS_TIMEOUT_MS
    });
    if (result.exitCode !== 0) return false;
    return parseServeStatusJson(result.stdout);
  } catch {
    return false;
  }
}

/** `new URL().port` is empty for the scheme's default port — fill it in explicitly. */
export function extractLocalPort(baseUrl: string): number {
  try {
    const url = new URL(baseUrl);
    if (url.port.trim().length > 0) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return 3030;
  }
}

export async function checkApiReachable(baseUrl: string, fetchImpl: typeof globalThis.fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Auth is off by default in this 1-user codebase — mirrors the exact env
 * pair `packages/autoconfigure/src/auth-wiring.ts` gates on.
 */
export function authPosture(env: NodeJS.ProcessEnv): "on" | "off" {
  const jwtSecret = env.MUSE_AUTH_JWT_SECRET?.trim();
  const secretsFile = env.MUSE_AUTH_SECRETS_FILE?.trim();
  return (jwtSecret && jwtSecret.length > 0) || (secretsFile && secretsFile.length > 0) ? "on" : "off";
}

export function phoneUrl(dnsName: string): string {
  return `https://${dnsName}`;
}

export interface RemoteCommandDeps {
  readonly run: RemoteRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly baseUrl: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly cwd?: string;
  readonly exists?: (path: string) => boolean;
  readonly osPlatform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runRemoteStatusCommand(deps: RemoteCommandDeps): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const osPlatform = deps.osPlatform ?? platform();
  const env = deps.env ?? process.env;
  const { run, stdout } = deps;

  const binary = await resolveTailscaleBinary({ cwd, exists: deps.exists, osPlatform, run });
  if (!binary) {
    stdout(`tailscale: not installed — install it from ${installUrlForPlatform(osPlatform)}\n`);
    stdout("serve: unknown (tailscale not installed)\n");
  } else {
    stdout(`tailscale: found (${binary})\n`);
    const login = await checkTailscaleLogin({ binary, cwd, run });
    stdout(
      login.loggedIn
        ? "logged in: yes\n"
        : `logged in: no (state: ${login.backendState}) — run \`tailscale up\` to log in\n`
    );
    const serveActive = await checkServeActive({ binary, cwd, run });
    stdout(serveActive ? "serve: active\n" : "serve: off\n");
    if (serveActive && login.dnsName) {
      stdout(`phone URL: ${phoneUrl(login.dnsName)}\n`);
    }
  }

  const apiReachable = await checkApiReachable(deps.baseUrl, deps.fetchImpl);
  stdout(apiReachable ? `API server: reachable (${deps.baseUrl})\n` : `API server: NOT reachable (${deps.baseUrl})\n`);

  const posture = authPosture(env);
  stdout(
    posture === "on"
      ? "auth: ON — a token is required to use Muse\n"
      : "auth: OFF — every device on your tailnet (normally just your own) can use Muse without logging in\n"
  );

  return 0;
}

export interface RemoteEnableDeps extends RemoteCommandDeps {
  readonly funnel: boolean;
}

export async function runRemoteEnableCommand(deps: RemoteEnableDeps): Promise<number> {
  const { run, stderr, stdout } = deps;
  const cwd = deps.cwd ?? process.cwd();
  const osPlatform = deps.osPlatform ?? platform();
  const env = deps.env ?? process.env;

  if (deps.funnel) {
    stderr(
      "muse remote enable: refusing --funnel — Tailscale Funnel exposes Muse to the PUBLIC internet, which is " +
      "out of scope by design. Muse only ever serves your own tailnet. Nothing was executed.\n"
    );
    return 1;
  }

  const binary = await resolveTailscaleBinary({ cwd, exists: deps.exists, osPlatform, run });
  if (!binary) {
    stderr(
      `muse remote enable: tailscale isn't installed. Install it from ${installUrlForPlatform(osPlatform)}, then ` +
      "run `muse remote enable` again. Nothing was executed.\n"
    );
    return 1;
  }

  const login = await checkTailscaleLogin({ binary, cwd, run });
  if (!login.loggedIn) {
    stderr(
      `muse remote enable: tailscale is installed but not logged in (state: ${login.backendState}). Run ` +
      "`tailscale up` to log in, then run `muse remote enable` again. Nothing was executed.\n"
    );
    return 1;
  }

  const apiReachable = await checkApiReachable(deps.baseUrl, deps.fetchImpl);
  if (!apiReachable) {
    stderr(
      `muse remote enable: the Muse API server isn't reachable at ${deps.baseUrl}. Start it (\`pnpm --filter ` +
      "@muse/api dev`, or however you normally run Muse), then run `muse remote enable` again. Nothing was executed.\n"
    );
    return 1;
  }

  const alreadyActive = await checkServeActive({ binary, cwd, run });
  const port = extractLocalPort(deps.baseUrl);
  if (!alreadyActive) {
    const result = await run({ args: ["serve", "--bg", String(port)], command: binary, cwd, timeoutMs: SERVE_TIMEOUT_MS });
    if (result.exitCode !== 0 || result.timedOut) {
      stderr(
        `muse remote enable: \`tailscale serve --bg ${String(port)}\` failed — ` +
        `${(result.stderr || result.stdout || "unknown error").trim()}\n`
      );
      return 1;
    }
  }

  if (!login.dnsName) {
    stderr(
      "muse remote enable: serve is running, but your tailnet DNS name couldn't be resolved — check " +
      "`tailscale status --json`.\n"
    );
    return 1;
  }

  stdout(`✓ Muse is now available on your tailnet: ${phoneUrl(login.dnsName)}\n`);
  stdout(
    "이 주소를 휴대폰(같은 Tailscale 계정)에서 열면 Muse에 접속됩니다 / open this on your phone " +
    "(any device on your tailnet).\n"
  );

  if (authPosture(env) === "off") {
    stdout(
      "⚠ auth is OFF — every device on your tailnet (normally just your own) can use Muse without logging in. " +
      "Set MUSE_AUTH_JWT_SECRET (or MUSE_AUTH_SECRETS_FILE) to require a token, then restart the API server.\n"
    );
  }

  return 0;
}

export async function runRemoteDisableCommand(deps: RemoteCommandDeps): Promise<number> {
  const { run, stderr, stdout } = deps;
  const cwd = deps.cwd ?? process.cwd();
  const osPlatform = deps.osPlatform ?? platform();

  const binary = await resolveTailscaleBinary({ cwd, exists: deps.exists, osPlatform, run });
  if (!binary) {
    stdout("tailscale isn't installed — nothing to turn off.\n");
    return 0;
  }

  const alreadyActive = await checkServeActive({ binary, cwd, run });
  if (!alreadyActive) {
    stdout("muse remote: serve is already off. Nothing to do.\n");
    return 0;
  }

  const result = await run({ args: ["serve", "reset"], command: binary, cwd, timeoutMs: SERVE_TIMEOUT_MS });
  if (result.exitCode !== 0 || result.timedOut) {
    stderr(`muse remote disable: \`tailscale serve reset\` failed — ${(result.stderr || result.stdout || "unknown error").trim()}\n`);
    return 1;
  }
  stdout("✓ Muse is no longer being served on your tailnet.\n");
  return 0;
}

export interface RemoteCommandHelpers {
  readonly run?: RemoteRunner;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly cwd?: string;
  readonly existsSync?: (path: string) => boolean;
  readonly osPlatform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export function registerRemoteCommand(program: Command, io: ProgramIO, helpers: RemoteCommandHelpers = {}): void {
  const remote = program
    .command("remote")
    .description("Serve the Muse web UI to your own devices over Tailscale (tailnet-only, never the public internet)");

  const baseDeps = async (command: Command): Promise<RemoteCommandDeps> => {
    const { baseUrl } = await readApiOptions(io, command, { includeStoredToken: false });
    return {
      baseUrl,
      cwd: helpers.cwd ?? process.cwd(),
      env: helpers.env ?? process.env,
      ...(helpers.existsSync ? { exists: helpers.existsSync } : {}),
      fetchImpl: helpers.fetchImpl ?? io.fetch ?? globalThis.fetch,
      ...(helpers.osPlatform ? { osPlatform: helpers.osPlatform } : {}),
      run: helpers.run ?? defaultRemoteRunner,
      stderr: io.stderr,
      stdout: io.stdout
    };
  };

  remote
    .command("status")
    .description("Check tailscale install/login, serve state, API-server reachability, and auth posture")
    .action(async (_options: unknown, command: Command) => {
      const exitCode = await runRemoteStatusCommand(await baseDeps(command));
      if (exitCode !== 0) process.exitCode = exitCode;
    });

  remote
    .command("enable")
    .description("Serve the Muse web UI to your tailnet and print the phone URL (never exposes publicly)")
    .option("--funnel", "Refused on purpose — Tailscale Funnel would expose Muse to the public internet")
    .action(async (options: { readonly funnel?: boolean }, command: Command) => {
      const exitCode = await runRemoteEnableCommand({ ...(await baseDeps(command)), funnel: Boolean(options.funnel) });
      if (exitCode !== 0) process.exitCode = exitCode;
    });

  remote
    .command("disable")
    .description("Turn off tailnet serving (idempotent — a no-op when not currently serving)")
    .action(async (_options: unknown, command: Command) => {
      const exitCode = await runRemoteDisableCommand(await baseDeps(command));
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}
