/**
 * Shared plumbing for the Apple-app mirrors ({@link "./macos-reminders-mirror.js"},
 * {@link "./macos-notes-mirror.js"}): the opt-in env-var gate and the
 * post-`exec` outcome mapping (timeout / exit-code / permission / thrown
 * error → a fail-soft warning string). Split out so both mirrors share one
 * behaviour instead of two copies that could drift.
 */

import { isPermissionError, type MacOsascriptRunner } from "./macos-exec.js";
import { parseBooleanFromEnv } from "@muse/shared";

export function isMirrorEnvEnabled(env: Record<string, string | undefined>, key: string): boolean {
  return parseBooleanFromEnv(env[key], false);
}

export interface MirrorScriptLabels {
  /** Human-readable app name for the warning prefix, e.g. "Apple Reminders". */
  readonly app: string;
  /** The Automation-permission target named in the permission-denied hint, e.g. "Reminders". */
  readonly permissionTarget: string;
}

export interface MirrorScriptOutcome {
  /** True only when the script ran and osascript exited 0. */
  readonly mirrored: boolean;
  /** Fail-soft, human-readable reason the mirror did not land. Never thrown. */
  readonly warning?: string;
}

/**
 * Run one generated AppleScript through `exec` and map the outcome to a
 * fail-soft result — never throws. Shared tail of both mirrors' create path:
 * timeout, non-zero exit (with a permission-specific hint), or a thrown spawn
 * error all become a `warning` instead of an exception.
 */
export async function runMirrorScript(
  exec: MacOsascriptRunner,
  script: string,
  labels: MirrorScriptLabels
): Promise<MirrorScriptOutcome> {
  try {
    const result = await exec(script);
    if (result.timedOut) {
      return { mirrored: false, warning: `${labels.app} mirror timed out (osascript was killed)` };
    }
    if (result.exitCode !== 0) {
      const reason = isPermissionError(result.stderr)
        ? `Automation permission denied — grant ${labels.permissionTarget} access in System Settings → Privacy & Security → Automation`
        : (result.stderr.trim().slice(0, 300) || `osascript exited ${String(result.exitCode)}`);
      return { mirrored: false, warning: `${labels.app} mirror failed: ${reason}` };
    }
    return { mirrored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { mirrored: false, warning: `${labels.app} mirror failed: ${message}` };
  }
}
