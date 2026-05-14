/**
 * `muse show <image>` — inline terminal image render via the
 * iTerm2 inline-image protocol (goal 096).
 *
 * Spec: https://iterm2.com/documentation-images.html
 * Honored by iTerm2, WezTerm, Tabby. The escape sequence is
 *   ESC ] 1337 ; File = inline=1 ; name=<b64-name> : <b64-image> BEL
 *
 * Falls back to `open <path>` (macOS) / `xdg-open` (Linux) on
 * terminals that don't advertise inline support — opt out of
 * the fallback with `--inline-only` so a piped consumer gets
 * predictable bytes regardless of TERM_PROGRAM.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface ShowOptions {
  readonly name?: string;
  readonly inlineOnly?: boolean;
}

/**
 * Goal 096 — detect inline-image support from the terminal env.
 * Pure so the unit test pins each branch without process-env
 * mutation gymnastics.
 */
export function detectInlineImageSupport(env: NodeJS.ProcessEnv): boolean {
  const program = env.TERM_PROGRAM?.trim();
  if (program === "iTerm.app" || program === "WezTerm" || program === "tabby") {
    return true;
  }
  const term = env.TERM?.trim() ?? "";
  if (term.startsWith("xterm-kitty")) return true;
  return false;
}

/**
 * Goal 096 — build the iTerm2 inline-image escape sequence.
 * Pure (bytes in, bytes out) so the test can pin the shape
 * without writing to stdout. Format:
 *
 *   ESC ] 1337 ; File = inline=1 ; name=<b64-name> : <b64-image> BEL
 *
 * `name` defaults to the path's basename so the terminal
 * displays a readable label.
 */
export function buildIterm2InlineImageSequence(args: {
  readonly imageBytes: Buffer;
  readonly name: string;
}): string {
  const b64Name = Buffer.from(args.name, "utf8").toString("base64");
  const b64Image = args.imageBytes.toString("base64");
  return `\x1b]1337;File=inline=1;name=${b64Name}:${b64Image}\x07`;
}

async function externalOpen(path: string): Promise<number> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, [path], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export function registerShowCommand(program: Command, io: ProgramIO): void {
  program
    .command("show")
    .description("Render an image inline in the terminal (iTerm2/Kitty/WezTerm). Falls back to native viewer on plain terminals. (goal 096)")
    .argument("<path>", "Path to an image file")
    .option("--name <label>", "Label shown in the inline header (default: basename of <path>)")
    .option("--inline-only", "Skip the open/xdg-open fallback when inline support is unavailable")
    .action(async (filePath: string, options: ShowOptions) => {
      let imageBytes: Buffer;
      try {
        imageBytes = await readFile(filePath);
      } catch (cause) {
        io.stderr(`muse show: could not read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const inlineCapable = detectInlineImageSupport(process.env);
      if (inlineCapable || options.inlineOnly) {
        const sequence = buildIterm2InlineImageSequence({
          imageBytes,
          name: options.name ?? basename(filePath)
        });
        io.stdout(`${sequence}\n`);
        if (!inlineCapable && options.inlineOnly) {
          io.stderr("(terminal does not advertise inline image support — emitted bytes anyway because --inline-only is set)\n");
        }
        return;
      }
      // Fallback: hand the image to the OS viewer.
      const exit = await externalOpen(filePath).catch(() => -1);
      if (exit !== 0) {
        io.stderr(`muse show: terminal lacks inline-image support and the native viewer (\`open\`/\`xdg-open\`) returned ${exit.toString()}. Re-run with --inline-only to force the escape sequence.\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(`(opened ${filePath} via the system viewer; this terminal doesn't advertise inline-image support)\n`);
    });
}
