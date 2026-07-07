/**
 * `muse logo` — print the Muse mascot (the bluebird) as terminal art.
 * The bird is rendered from the canonical pixel data in `@muse/mascot`;
 * the wordmark spells MUSE. On an interactive colour terminal the bird
 * blinks once. This is a showcase/banner command, not a data task.
 */

import type { Command } from "commander";

import { MUSE_TAGLINE } from "./muse-identity.js";
import { MUSE_BIRD_ANSI, MUSE_BIRD_BLINK_ANSI, MUSE_BIRD_ROWS, MUSE_WORDMARK } from "./muse-mascot.js";
import type { ProgramIO } from "./program.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Redraw the top `rows` lines in place: cursor up, clear each line, reprint. */
function redrawBird(io: ProgramIO, art: string): void {
  const cleared = art
    .split("\n")
    .map((line) => `\x1b[2K${line}`)
    .join("\n");
  io.stdout(`\x1b[${MUSE_BIRD_ROWS}A${cleared}\n`);
}

export function registerLogoCommand(program: Command, io: ProgramIO): void {
  program
    .command("logo")
    .description("Print the Muse mascot (the bluebird) as terminal art. Use to show Muse's banner/logo; not for any data or agent task.")
    .action(async () => {
      // NO_COLOR wins (https://no-color.org/); otherwise this showcase command
      // always renders the truecolour bird, TTY or not.
      const color = process.env.NO_COLOR === undefined;
      if (!color) {
        io.stdout(`${MUSE_WORDMARK.join("\n")}\n${MUSE_TAGLINE}\n`);
        return;
      }

      io.stdout(`${MUSE_BIRD_ANSI}\n`);

      if (process.stdout.isTTY) {
        await sleep(900);
        redrawBird(io, MUSE_BIRD_BLINK_ANSI);
        await sleep(150);
        redrawBird(io, MUSE_BIRD_ANSI);
      }

      io.stdout(`${MUSE_WORDMARK.join("\n")}\n${MUSE_TAGLINE}\n`);
    });
}
