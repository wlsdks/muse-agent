import { parseBoolean } from "@muse/autoconfigure";
import {
  readDaemonSettingsSync,
  readQuietHoursSettingSync,
  resolveDaemonSettingsFile,
  UnsupportedDaemonSettingsFormatError,
  writeDaemonSetting,
  writeQuietHoursSetting,
  type DaemonSettings,
  type PersistedQuietHours
} from "@muse/stores";

/**
 * The read/write primitives now live in `@muse/stores` (promoted so
 * `apps/cli` can read the SAME file without importing apps/api — see that
 * module's doc comment). Re-exported here so the existing call sites
 * (doctor-routes, settings-routes, server.ts) keep their import path.
 */
export {
  readDaemonSettingsSync,
  readQuietHoursSettingSync,
  resolveDaemonSettingsFile,
  UnsupportedDaemonSettingsFormatError,
  writeDaemonSetting,
  writeQuietHoursSetting
};
export type { DaemonSettings, PersistedQuietHours };

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
