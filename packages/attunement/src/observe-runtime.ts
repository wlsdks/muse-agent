import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";

import { isRecord, parseStrictJson } from "@muse/shared";

import { createObserveCollector, type ObserveCollector } from "./observe-collector.js";
import { OBSERVE_APP_CATEGORIES, ObserveStoreError, canonicalObserveTarget, readObserveState, type ObserveAppCategory } from "./observe-store.js";

export interface ObserveAppMapping {
  readonly apps: Readonly<Record<string, ObserveAppCategory>>;
  readonly version: 1;
}

export interface ObserveActiveAppSource {
  read(): Promise<string>;
}

export interface ObserveCommandResult {
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}

export type ObserveCommandExecutor = (executable: string, args: readonly string[]) => Promise<ObserveCommandResult>;

export interface ObserveRunner {
  shutdown(): Promise<void>;
  tick(): Promise<"busy" | "ignored" | "sampled">;
}

export interface ObserveRunnerEnvironmentOptions {
  readonly assertKnownThread: (threadId: string) => Promise<void>;
  readonly attunementFile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execute?: ObserveCommandExecutor;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

const MACOS_EXECUTABLE = "/usr/bin/osascript";
const MACOS_ARGS = ["-e", "tell application \"System Events\" to get bundle identifier of first application process whose frontmost is true"] as const;
const WINDOWS_EXECUTABLE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "$signature='[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);'; $native=Add-Type -MemberDefinition $signature -Name ObserveForeground -Namespace Muse -PassThru; $processId=0; $handle=$native::GetForegroundWindow(); [void]$native::GetWindowThreadProcessId($handle,[ref]$processId); (Get-Process -Id $processId).ProcessName"] as const;

export async function readObserveAppMapping(file: string): Promise<ObserveAppMapping> {
  const entry = await fs.lstat(file).catch((cause: unknown) => {
    throw new ObserveStoreError("invalid", "Observe app mapping cannot be opened", { cause });
  });
  if (entry.isSymbolicLink() || !entry.isFile()) throw new ObserveStoreError("invalid", "Observe app mapping must be a non-symlink regular file");
  if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) throw new ObserveStoreError("invalid", "Observe app mapping permissions must be owner-only");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (cause) {
    throw new ObserveStoreError("invalid", "Observe app mapping cannot be opened", { cause });
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size > 64 * 1024
      || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) throw new ObserveStoreError("invalid", "Observe app mapping identity or permissions changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await fs.lstat(file).catch(() => undefined);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength > 64 * 1024) {
      throw new ObserveStoreError("conflict", "Observe app mapping changed while it was read");
    }
    if (pathAfter === undefined || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || (process.platform !== "win32" && (pathAfter.mode & 0o077) !== 0)) throw new ObserveStoreError("conflict", "Observe app mapping identity changed while it was read");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (cause) { throw new ObserveStoreError("invalid", "Observe app mapping is not valid UTF-8", { cause }); }
    let parsed: unknown;
    try { parsed = parseStrictJson(text, { maxArrayItems: 0, maxDepth: 4, maxNodes: 1_024, maxObjectMembers: 258 }); }
    catch (cause) { throw new ObserveStoreError("invalid", "Observe app mapping contains invalid JSON", { cause }); }
    if (!isRecord(parsed) || !exactKeys(parsed, ["version", "apps"]) || parsed.version !== 1 || !isRecord(parsed.apps)) {
      throw new ObserveStoreError("invalid", "Observe app mapping has an unsupported schema");
    }
    const entries = Object.entries(parsed.apps);
    if (entries.length > 256) throw new ObserveStoreError("invalid", "Observe app mapping exceeds its entry limit");
    const apps: Record<string, ObserveAppCategory> = Object.create(null) as Record<string, ObserveAppCategory>;
    for (const [appId, category] of entries) {
      if (!validSourceId(appId) || !OBSERVE_APP_CATEGORIES.includes(category as ObserveAppCategory)) {
        throw new ObserveStoreError("invalid", "Observe app mapping contains an invalid entry");
      }
      apps[appId] = category as ObserveAppCategory;
    }
    return { apps, version: 1 };
  } finally {
    await handle.close();
  }
}

export function createObserveActiveAppSource(
  platform: "macos" | "windows",
  execute: ObserveCommandExecutor = executeBounded
): ObserveActiveAppSource {
  const executable = platform === "macos" ? MACOS_EXECUTABLE : WINDOWS_EXECUTABLE;
  const args = platform === "macos" ? MACOS_ARGS : WINDOWS_ARGS;
  return {
    async read() {
      let result: ObserveCommandResult;
      try { result = await execute(executable, args); }
      catch { throw new ObserveStoreError("conflict", "Observe active-app source failed"); }
      if (result.exitCode !== 0 || result.stderr.byteLength !== 0 || result.stdout.byteLength > 4_096 || result.stderr.byteLength > 4_096) {
        throw new ObserveStoreError("conflict", "Observe active-app source returned an invalid result");
      }
      let output: string;
      try { output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
      catch { throw new ObserveStoreError("conflict", "Observe active-app source returned invalid text"); }
      const id = output.endsWith("\r\n") ? output.slice(0, -2) : output.endsWith("\n") ? output.slice(0, -1) : undefined;
      if (id === undefined || !validSourceId(id)) throw new ObserveStoreError("conflict", "Observe active-app source returned an invalid identifier");
      return id;
    }
  };
}

export function createObserveRunner(input: {
  readonly collector: ObserveCollector;
  readonly mapping: ObserveAppMapping;
  readonly now?: () => Date;
  readonly source: ObserveActiveAppSource;
}): ObserveRunner {
  let running = false;
  let closed = false;
  let inFlight: Promise<"ignored" | "sampled"> | undefined;
  return {
    async tick() {
      if (closed) return "ignored";
      if (running) return "busy";
      running = true;
      const observedAt = (input.now ?? (() => new Date()))().toISOString();
      const execute = async (): Promise<"ignored" | "sampled"> => {
        await input.collector.claim(observedAt);
        let rawId: string;
        try { rawId = await input.source.read(); }
        catch { return "ignored"; }
        const category = Object.hasOwn(input.mapping.apps, rawId) ? input.mapping.apps[rawId] : undefined;
        if (category === undefined) return "ignored";
        await input.collector.sample(category, observedAt);
        return "sampled";
      };
      inFlight = execute();
      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
        running = false;
      }
    },
    async shutdown() {
      closed = true;
      try { await inFlight; } catch { /* release below remains best effort */ }
      try { await input.collector.release(); } catch { /* best effort */ }
    }
  };
}

/** Build one CLI/API daemon handle only after the complete config and map validate. */
export async function createObserveRunnerFromEnvironment(options: ObserveRunnerEnvironmentOptions): Promise<ObserveRunner | undefined> {
  if (options.env.MUSE_OBSERVE_ENABLED !== "true") return undefined;
  const sessionId = requiredEnv(options.env.MUSE_OBSERVE_SESSION_ID, "MUSE_OBSERVE_SESSION_ID");
  const threadId = requiredEnv(options.env.MUSE_OBSERVE_THREAD_ID, "MUSE_OBSERVE_THREAD_ID");
  const configuredPlatform = requiredEnv(options.env.MUSE_OBSERVE_PLATFORM, "MUSE_OBSERVE_PLATFORM");
  const mappingFile = requiredEnv(options.env.MUSE_OBSERVE_MAP_FILE, "MUSE_OBSERVE_MAP_FILE");
  const intervalText = requiredEnv(options.env.MUSE_OBSERVE_INTERVAL_MS, "MUSE_OBSERVE_INTERVAL_MS");
  const intervalMs = Number(intervalText);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 5 * 60_000) throw new ObserveStoreError("invalid", "MUSE_OBSERVE_INTERVAL_MS is invalid");
  const actual = options.platform ?? process.platform;
  const expectedPlatform = actual === "darwin" ? "macos" : actual === "win32" ? "windows" : undefined;
  if (expectedPlatform === undefined || configuredPlatform !== expectedPlatform) throw new ObserveStoreError("invalid", "Observe platform does not match this host");
  const mapping = await readObserveAppMapping(mappingFile);
  const attunementFile = await canonicalObserveTarget(options.attunementFile);
  const observeFile = `${attunementFile}.observe.json`;
  await options.assertKnownThread(threadId);
  const configuredSession = (await readObserveState(observeFile)).sessions.find((session) => session.id === sessionId);
  if (configuredSession?.threadId !== threadId || configuredSession.status !== "active" || configuredSession.consentVersion !== 1) {
    throw new ObserveStoreError("conflict", "configured Observe session does not match the active PersonalThread");
  }
  const collector = createObserveCollector({
    attunementFile,
    file: observeFile,
    intervalMs,
    ...(options.now ? { now: options.now } : {}),
    sessionId,
    threadId
  });
  const source = options.execute === undefined
    ? createObserveActiveAppSource(expectedPlatform)
    : createObserveActiveAppSource(expectedPlatform, options.execute);
  return createObserveRunner({ collector, mapping, ...(options.now ? { now: options.now } : {}), source });
}

function executeBounded(executable: string, args: readonly string[]): Promise<ObserveCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { encoding: "buffer", maxBuffer: 4_096, timeout: 2_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ exitCode: 0, stderr, stdout });
    });
  });
}

function validSourceId(value: string): boolean {
  return Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes("\n") && !value.includes("\r");
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requiredEnv(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ObserveStoreError("invalid", `${name} is required and must be exact`);
  }
  return value;
}
