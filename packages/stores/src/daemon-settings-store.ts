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

import { isRecord } from "@muse/shared";
import { atomicWriteFile } from "./atomic-file-store.js";

export type DaemonSettings = Readonly<Record<string, boolean>>;

export interface PersistedQuietHours {
  readonly enabled: boolean;
  /** "HH:MM-HH:MM" (or bare "H-H") — validated by @muse/proactivity's parseQuietHours at the read site, not here. */
  readonly range: string;
}

interface DaemonSettingsFile {
  readonly flags?: Record<string, unknown>;
  readonly quietHours?: unknown;
  readonly version?: number;
}

export function resolveDaemonSettingsFile(env: { readonly [key: string]: string | undefined }): string {
  const override = env.MUSE_DAEMON_SETTINGS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".muse", "daemon-settings.json");
}

function readDaemonSettingsFileSync(file: string): DaemonSettingsFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {};
    }
    const version = typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : undefined;
    const out: DaemonSettingsFile = {};
    if (isRecord(parsed.flags)) {
      out.flags = parsed.flags;
    }
    if (parsed.quietHours !== undefined) {
      out.quietHours = parsed.quietHours;
    }
    if (version !== undefined) {
      out.version = version;
    }
    return out;
  } catch {
    return {};
  }
}

export function readDaemonSettingsSync(file: string): DaemonSettings {
  const parsed = readDaemonSettingsFileSync(file);
    if (!parsed.flags || typeof parsed.flags !== "object") {
      return {};
    }
    const out: DaemonSettings = {};
    for (const [key, value] of Object.entries(parsed.flags)) {
      if (typeof value === "boolean") {
        out[key] = value;
      }
    }
    return out;
  }

/**
 * Undefined when absent, malformed, or shape-invalid (missing/wrong-typed
 * `enabled`/`range`) — the caller (`resolveEffectiveQuietHours`) treats that
 * identically to "no persisted setting", never a crash.
 */
export function readQuietHoursSettingSync(file: string): PersistedQuietHours | undefined {
  const raw = readDaemonSettingsFileSync(file).quietHours;
  if (!isRecord(raw)) {
    return undefined;
  }
  const enabled = raw.enabled;
  const range = raw.range;
  if (typeof enabled !== "boolean" || typeof range !== "string") {
    return undefined;
  }
  return { enabled, range };
}

async function writeDaemonSettingsFile(file: string, next: DaemonSettingsFile): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
}

export async function writeDaemonSetting(file: string, key: string, enabled: boolean): Promise<void> {
  const current = readDaemonSettingsFileSync(file);
  await writeDaemonSettingsFile(file, {
    ...(current.quietHours !== undefined ? { quietHours: current.quietHours } : {}),
    flags: { ...(current.flags ?? {}), [key]: enabled },
    version: 1
  });
}

/** `null` clears the persisted setting (falls back to env-only resolution). */
export async function writeQuietHoursSetting(file: string, setting: PersistedQuietHours | null): Promise<void> {
  const current = readDaemonSettingsFileSync(file);
  await writeDaemonSettingsFile(file, {
    flags: current.flags ?? {},
    quietHours: setting,
    version: 1
  });
}
