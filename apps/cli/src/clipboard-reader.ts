import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Read the OS clipboard so `muse ask --clipboard` can ground on text the user
 * just copied — the ephemeral sibling of `--file` / `--url`. Read-only and
 * local: it shells out to the platform's standard clipboard tool and never
 * leaves the machine.
 */

export interface ClipboardCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * The clipboard-read command for a platform, or `undefined` when none is known.
 * Pure (no spawn) so the platform mapping is unit-testable without a real
 * clipboard. macOS ships `pbpaste`; Windows has PowerShell `Get-Clipboard`;
 * Linux relies on `xclip` (the common X selection tool).
 */
export function clipboardCommand(platform: NodeJS.Platform): ClipboardCommand | undefined {
  if (platform === "darwin") return { args: [], cmd: "pbpaste" };
  if (platform === "win32") return { args: ["-NoProfile", "-Command", "Get-Clipboard"], cmd: "powershell" };
  if (platform === "linux") return { args: ["-selection", "clipboard", "-o"], cmd: "xclip" };
  return undefined;
}

/**
 * Read the clipboard as text. Throws with a clear message on an unsupported
 * platform or when the underlying tool is missing / errors — the caller treats
 * that as "no clipboard grounding this turn", never a silent empty answer.
 */
export async function readClipboardText(platform: NodeJS.Platform = process.platform): Promise<string> {
  const spec = clipboardCommand(platform);
  if (!spec) {
    throw new Error(`clipboard read is not supported on ${platform}`);
  }
  const { stdout } = await execFile(spec.cmd, [...spec.args], { maxBuffer: 4_000_000 });
  return stdout;
}
