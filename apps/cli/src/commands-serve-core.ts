/**
 * `muse serve` core: port/host resolution, the /health preflight probe, the
 * pure spawn-vs-replace-vs-refuse decision, the version-gate shutdown+wait
 * sequence, and the foreground spawn + signal wiring. Split out of
 * commands-serve.ts (commander wiring) so each piece is independently
 * unit-testable — mirrors commands-update.ts's pure-helper split and
 * commands-daemon-register.ts's injected-runner + vitest-guard pattern.
 */

import { spawn as nodeSpawn } from "node:child_process";

import { errorMessage } from "@muse/shared";

/**
 * Duplicated from apps/api/src/listen-config.ts (verbatim parsing logic,
 * kept in lockstep by hand): apps/cli cannot depend on apps/api (a sibling
 * deployable, not a `packages/*` library), yet `muse serve` must resolve the
 * SAME port/host apps/api/dist/index.js will bind to, before it spawns it.
 */
export function resolveServePort(raw: string | undefined, fallback = 3030): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function resolveServeHost(raw: string | undefined, fallback = "127.0.0.1"): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** A bind host of "all interfaces" isn't a valid client-side connect target on every platform — probe loopback instead. */
export function hostForProbe(host: string): string {
  return host === "0.0.0.0" || host === "::" || host.trim().length === 0 ? "127.0.0.1" : host;
}

export interface ServeHealthPayload {
  readonly pid: number;
  readonly startedAtIso: string;
  readonly version: string;
}

export type ServeProbeResult =
  | { readonly kind: "free" }
  | ({ readonly kind: "healthy" } & ServeHealthPayload)
  | { readonly kind: "ambiguous"; readonly detail: string }
  | { readonly kind: "non-muse"; readonly detail: string };

function isConnectionRefused(cause: unknown): boolean {
  const err = cause as { readonly cause?: { readonly code?: string }; readonly code?: string } | undefined;
  const code = err?.cause?.code ?? err?.code;
  return code === "ECONNREFUSED";
}

/**
 * GET <healthUrl> and classify what's there. A response that parses as a
 * JSON object but is missing the /health shape (`version`/`pid`/
 * `startedAtIso`) is "ambiguous" — grouped with a different-buildId server
 * (offer --replace) rather than hard-refused, because it might still be an
 * older/newer Muse schema. A non-JSON response (HTML, plain text, a reset)
 * is "non-muse" — hard fail-close, --replace never applies to it.
 */
export async function probeServeHealth(
  fetchImpl: typeof globalThis.fetch,
  healthUrl: string,
  timeoutMs = 1500
): Promise<ServeProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    if (isConnectionRefused(cause)) return { kind: "free" };
    return { kind: "ambiguous", detail: errorMessage(cause, "health probe failed") };
  }
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return { kind: "non-muse", detail: `HTTP ${String(response.status)}, non-JSON response` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "non-muse", detail: `HTTP ${String(response.status)}, body was not valid JSON` };
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record
    || typeof record.version !== "string"
    || typeof record.pid !== "number"
    || typeof record.startedAtIso !== "string"
  ) {
    return { kind: "ambiguous", detail: `HTTP ${String(response.status)} answered but not with the Muse API /health payload shape` };
  }
  return { kind: "healthy", pid: record.pid, startedAtIso: record.startedAtIso, version: record.version };
}

export type ServeDecision =
  | { readonly action: "spawn" }
  | { readonly action: "already-running"; readonly payload: ServeHealthPayload; readonly bothDev: boolean }
  | { readonly action: "offer-replace"; readonly detail: string }
  | { readonly action: "replace" }
  | { readonly action: "fail-non-muse"; readonly detail: string };

/**
 * Pure: given what's on the port, this CLI's own build id, and whether
 * --replace was passed, decide what `muse serve` does next. No I/O — every
 * branch (never spawn on a same-build healthy server, never replace without
 * --replace, never touch a non-Muse occupant) is directly unit-testable.
 */
export function decideServeAction(
  probe: ServeProbeResult,
  plannedBuildId: string,
  replaceRequested: boolean
): ServeDecision {
  if (probe.kind === "free") return { action: "spawn" };
  if (probe.kind === "non-muse") return { action: "fail-non-muse", detail: probe.detail };
  if (probe.kind === "healthy") {
    if (probe.version === plannedBuildId) {
      // dev-vs-dev is indistinguishable (plain dist has no build id), so the
      // already-running message advertises --replace as the escape hatch —
      // an EXPLICIT --replace must therefore win over the same-version
      // short-circuit here, or the CLI instructs an action it then ignores.
      if (plannedBuildId === "dev" && replaceRequested) {
        return { action: "replace" };
      }
      return { action: "already-running", bothDev: plannedBuildId === "dev", payload: probe };
    }
    return replaceRequested
      ? { action: "replace" }
      : { action: "offer-replace", detail: `found version "${probe.version}", this CLI would start "${plannedBuildId}"` };
  }
  // ambiguous
  return replaceRequested ? { action: "replace" } : { action: "offer-replace", detail: probe.detail };
}

export interface ShutdownAndWaitResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * POST /api/admin/shutdown (loopback-only server-side; see doctor-routes.ts)
 * then poll /health until the port frees or `waitMs` elapses. Never claims
 * success without observing the port actually go free — a shutdown request
 * that returns 200 but a server that hangs mid-drain must not race a spawn
 * into the still-occupied port.
 */
export async function shutdownAndWaitFree(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  healthUrl: string,
  opts: {
    readonly token?: string;
    readonly waitMs?: number;
    readonly pollMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<ShutdownAndWaitResult> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/admin/shutdown", baseUrl).toString(), {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      method: "POST"
    });
  } catch (cause) {
    return { detail: errorMessage(cause, "shutdown request failed"), ok: false };
  }
  if (!response.ok) {
    return { detail: `shutdown request returned HTTP ${String(response.status)}`, ok: false };
  }
  const waitMs = opts.waitMs ?? 10_000;
  const pollMs = opts.pollMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const probe = await probeServeHealth(fetchImpl, healthUrl, 500);
    if (probe.kind === "free") return { ok: true };
    await sleep(pollMs);
  }
  return { detail: `port did not free within ${String(waitMs)}ms after the shutdown request`, ok: false };
}

export interface ServeChildHandle {
  readonly pid?: number;
  kill(signal: NodeJS.Signals): void;
  waitForExit(): Promise<number | null>;
}

export type ServeSpawnFn = (opts: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) => ServeChildHandle;

function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

/**
 * Never spawns a real child under vitest, even if a test forgets to inject
 * `spawn` — a forgotten injection would otherwise boot a real API server
 * from inside the test run.
 */
export const defaultServeSpawn: ServeSpawnFn = ({ args, command, cwd, env }) => {
  if (isRunningUnderVitest()) {
    throw new Error(`refusing to spawn a real '${command} ${args.join(" ")}' under vitest — inject spawn in this test`);
  }
  const child = nodeSpawn(command, args, { cwd, env, stdio: "inherit" });
  return {
    kill: (signal) => { child.kill(signal); },
    pid: child.pid,
    waitForExit: () => new Promise<number | null>((resolve) => {
      child.once("exit", (code) => { resolve(code); });
      child.once("error", () => { resolve(null); });
    })
  };
};

/**
 * Never reaches real `fetch` under vitest unless the caller (ProgramIO)
 * injects one — same fail-closed shape as `defaultServeSpawn`, so a test
 * that forgets `io.fetch` fails loudly instead of hitting a real port.
 */
export const defaultServeFetch: typeof globalThis.fetch = (async (input, init) => {
  if (isRunningUnderVitest()) {
    throw new Error("refusing a real network fetch under vitest — inject io.fetch in this test");
  }
  return globalThis.fetch(input, init);
}) as typeof globalThis.fetch;

/**
 * Spawn the server in the foreground (inherited stdio) and wire ctrl-c to an
 * explicit SIGTERM of the child — relying on process-group signal delivery
 * alone isn't guaranteed on every launcher shape, so this forwards it
 * itself (and the forward is what the SIGINT unit test proves via the
 * injected `registerSignalHandler` + a fake `spawn` that records `kill`).
 * Returns the child's exit code (0 when it exits with no code, e.g. via a
 * forwarded signal).
 */
export async function runServeForeground(opts: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: ServeSpawnFn;
  readonly stdout: (line: string) => void;
  readonly registerSignalHandler?: (event: "SIGINT" | "SIGTERM", handler: () => void) => void;
}): Promise<number> {
  const child = opts.spawn({ args: opts.args, command: opts.command, cwd: opts.cwd, env: opts.env });
  const register = opts.registerSignalHandler ?? ((event, handler) => { process.on(event, handler); });
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    opts.stdout("\n(stopping)\n");
    child.kill("SIGTERM");
  };
  register("SIGINT", onSignal);
  register("SIGTERM", onSignal);
  const exitCode = await child.waitForExit();
  return exitCode ?? 0;
}
