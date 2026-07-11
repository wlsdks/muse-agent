import { promises as fs, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseBoolean } from "@muse/autoconfigure";

/**
 * Mutable daemon toggles the web console can PATCH. The env flag stays
 * the launcher-level default; a value in this file is the user's live
 * choice and wins in BOTH directions. Read synchronously at boot (the
 * daemon blocks run inside buildServer) and re-read per toggle.
 */

export type DaemonSettings = Readonly<Record<string, boolean>>;

export function resolveDaemonSettingsFile(env: { readonly [key: string]: string | undefined }): string {
  const override = env.MUSE_DAEMON_SETTINGS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".muse", "daemon-settings.json");
}

export function readDaemonSettingsSync(file: string): DaemonSettings {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { flags?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.flags || typeof parsed.flags !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.flags as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
      )
    );
  } catch {
    return {};
  }
}

export async function writeDaemonSetting(file: string, key: string, enabled: boolean): Promise<void> {
  const next = { flags: { ...readDaemonSettingsSync(file), [key]: enabled }, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export function effectiveDaemonEnabled(
  key: string,
  env: { readonly [key: string]: string | undefined },
  settings: DaemonSettings
): boolean {
  const fromFile = settings[key];
  if (fromFile !== undefined) {
    return fromFile;
  }
  return parseBoolean(env[key], false);
}
