/**
 * `muse show <image>` — inline terminal image render via the
 * iTerm2 inline-image protocol.
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

import { looksLikeImage } from "./image-bytes.js";
import type { ProgramIO } from "./program.js";

interface ShowOptions {
  readonly name?: string;
  readonly inlineOnly?: boolean;
}

/**
 * Detect inline-image support from the terminal env.
 * Pure so the unit test pins each branch without process-env
 * mutation gymnastics.
 *
 * Recognise Ghostty (`TERM_PROGRAM=ghostty`) and the
 * VS Code integrated terminal (`TERM_PROGRAM=vscode`); both ship
 * the iTerm2 inline-image protocol natively (Ghostty since v1.0,
 * VS Code since 1.93). Without the recognition, `muse show`
 * silently falls back to `open` / `xdg-open` on those terminals
 * even though the bytes would have rendered inline correctly.
 */
const INLINE_IMAGE_TERM_PROGRAMS: ReadonlySet<string> = new Set([
  "iTerm.app",
  "WezTerm",
  "tabby",
  "ghostty",
  "vscode"
]);

export function detectInlineImageSupport(env: NodeJS.ProcessEnv): boolean {
  // Only terminals that honour the iTerm2 OSC-1337 protocol this
  // command emits. Kitty (`TERM=xterm-kitty`) deliberately is NOT
  // here: it uses its own, incompatible graphics protocol, so
  // claiming support would emit bytes it ignores AND suppress the
  // working OS-viewer fallback — a silent no-op for Kitty users.
  const program = env.TERM_PROGRAM?.trim();
  return Boolean(program && INLINE_IMAGE_TERM_PROGRAMS.has(program));
}

/**
 * Build the iTerm2 inline-image escape sequence.
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

/**
 * Wrap a terminal escape sequence in the tmux passthrough envelope
 * when running inside tmux. tmux intercepts and DISCARDS a raw
 * OSC-1337 inline-image sequence, so a `muse show` inside tmux (which
 * commonly forwards `TERM_PROGRAM=iTerm.app`, making us think inline
 * is supported) renders nothing. The passthrough — `ESC P tmux ; …
 * ESC \` with every inner ESC doubled — tells tmux to forward the
 * bytes verbatim to the outer terminal (requires `allow-passthrough`,
 * default on in tmux ≥ 3.5). Outside tmux the sequence is unchanged.
 */
export function wrapForTmux(sequence: string, inTmux: boolean): string {
  if (!inTmux) return sequence;
  return `\x1bPtmux;${sequence.replace(/\x1b/gu, "\x1b\x1b")}\x1b\\`;
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
    .description("Render an image inline in the terminal (iTerm2/WezTerm/Ghostty). Falls back to the native viewer on other terminals (incl. Kitty, which uses an incompatible protocol).")
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
      // A 0-byte file (e.g. a truncated / failed download) reads fine
      // but would emit an empty inline-image sequence — a silent no-op
      // on iTerm/WezTerm — or have the OS viewer "open" nothing. Fail
      // with a clear message instead.
      if (imageBytes.length === 0) {
        io.stderr(`muse show: ${filePath} is empty (0 bytes) — nothing to render.\n`);
        process.exitCode = 1;
        return;
      }
      // Reject a non-image file before emitting an inline-image sequence
      // (a broken-image glyph on iTerm/WezTerm) or handing a text/PDF to
      // the OS image viewer.
      if (!looksLikeImage(imageBytes)) {
        io.stderr(`muse show: ${filePath} doesn't look like an image (PNG/JPEG/GIF/WebP/BMP/HEIC) — muse show renders images, not text/PDF/other files.\n`);
        process.exitCode = 1;
        return;
      }
      const inlineCapable = detectInlineImageSupport(process.env);
      if (inlineCapable || options.inlineOnly) {
        const sequence = wrapForTmux(
          buildIterm2InlineImageSequence({
            imageBytes,
            name: options.name ?? basename(filePath)
          }),
          Boolean(process.env.TMUX)
        );
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
