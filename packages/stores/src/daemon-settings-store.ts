/**
 * Mutable daemon settings the web console (and CLI `muse quiet`) can PATCH:
 * boolean daemon toggles + the quiet-hours window. Promoted from apps/api so
 * `apps/cli` can read the SAME file WITHOUT importing apps/api
 * (architecture.md's app-boundary rule) — apps/api/src/daemon-settings-store.ts
 * now re-exports these primitives. Read synchronously (the daemon blocks read
 * it at boot and per-tick); write is atomic (tmp + rename via
 * `atomicWriteFile`) and always round-trips the OTHER top-level field so a
 * flags PATCH never clobbers a quietHours PATCH and vice versa.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";

export type DaemonSettings = Readonly<Record<string, boolean>>;

export interface PersistedQuietHours {
  readonly enabled: boolean;
  /** "HH:MM-HH:MM" (or bare "H-H") — validated by @muse/proactivity's parseQuietHours at the read site, not here. */
  readonly range: string;
}

interface DaemonSettingsFile {
  readonly flags?: Record<string, unknown>;
  readonly quietHours?: unknown;
  readonly version?: unknown;
}

const DAEMON_SETTINGS_VERSION = 1;
const UNSUPPORTED_DAEMON_SETTINGS_FILE = Symbol("unsupported-daemon-settings-file");

export class UnsupportedDaemonSettingsFormatError extends Error {
  constructor() {
    super("Daemon settings use an unsupported format; upgrade Muse before changing them.");
    this.name = "UnsupportedDaemonSettingsFormatError";
  }
}

export function resolveDaemonSettingsFile(env: { readonly [key: string]: string | undefined }): string {
  const override = env.MUSE_DAEMON_SETTINGS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  const injectedHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return join(injectedHome && injectedHome.length > 0 ? injectedHome : homedir(), ".muse", "daemon-settings.json");
}

function readDaemonSettingsFileSync(file: string): DaemonSettingsFile | typeof UNSUPPORTED_DAEMON_SETTINGS_FILE {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as DaemonSettingsFile
      : UNSUPPORTED_DAEMON_SETTINGS_FILE;
  } catch {
    return {};
  }
}

export function readDaemonSettingsSync(file: string): DaemonSettings {
  const parsed = readDaemonSettingsFileSync(file);
  if (parsed === UNSUPPORTED_DAEMON_SETTINGS_FILE) return {};
  if (!parsed.flags || typeof parsed.flags !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed.flags).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
  );
}

/**
 * Undefined when absent, malformed, or shape-invalid (missing/wrong-typed
 * `enabled`/`range`) — the caller (`resolveEffectiveQuietHours`) treats that
 * identically to "no persisted setting", never a crash.
 */
export function readQuietHoursSettingSync(file: string): PersistedQuietHours | undefined {
  const parsed = readDaemonSettingsFileSync(file);
  if (parsed === UNSUPPORTED_DAEMON_SETTINGS_FILE) return undefined;
  const raw = parsed.quietHours;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const enabled = (raw as { enabled?: unknown }).enabled;
  const range = (raw as { range?: unknown }).range;
  if (typeof enabled !== "boolean" || typeof range !== "string") {
    return undefined;
  }
  return { enabled, range };
}

async function writeDaemonSettingsFile(file: string, next: DaemonSettingsFile): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
}

function assertWritableDaemonSettingsFile(current: DaemonSettingsFile): void {
  if (current.version === undefined || current.version === DAEMON_SETTINGS_VERSION) return;

  throw new UnsupportedDaemonSettingsFormatError();
}

async function updateDaemonSettingsFile(
  file: string,
  update: (current: DaemonSettingsFile) => DaemonSettingsFile
): Promise<void> {
  await withFileMutationQueue(file, () => withFileLock(file, async () => {
    const current = readDaemonSettingsFileSync(file);
    if (current === UNSUPPORTED_DAEMON_SETTINGS_FILE) {
      throw new UnsupportedDaemonSettingsFormatError();
    }
    assertWritableDaemonSettingsFile(current);
    await writeDaemonSettingsFile(file, update(current));
  }));
}

export async function writeDaemonSetting(file: string, key: string, enabled: boolean): Promise<void> {
  await updateDaemonSettingsFile(file, (current) => ({
    ...(current.quietHours !== undefined ? { quietHours: current.quietHours } : {}),
    flags: { ...(current.flags ?? {}), [key]: enabled },
    version: DAEMON_SETTINGS_VERSION
  }));
}

/** `null` clears the persisted setting (falls back to env-only resolution). */
export async function writeQuietHoursSetting(file: string, setting: PersistedQuietHours | null): Promise<void> {
  await updateDaemonSettingsFile(file, (current) => ({
    flags: current.flags ?? {},
    quietHours: setting,
    version: DAEMON_SETTINGS_VERSION
  }));
}
