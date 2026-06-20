/**
 * `muse logo` — print the Muse mascot (the goddess) as terminal art.
 * The art lives in `muse-mascot-ansi.ts` (256-color grayscale half-block,
 * generated from the README hero image). This is a showcase/banner command,
 * not a data task.
 */

import type { Command } from "commander";

import { MUSE_MASCOT_ANSI } from "./muse-mascot-ansi.js";
import type { ProgramIO } from "./program.js";

export function registerLogoCommand(program: Command, io: ProgramIO): void {
  program
    .command("logo")
    .description("Print the Muse mascot (the goddess) as terminal art. Use to show Muse's banner/logo; not for any data or agent task.")
    .action(() => {
      io.stdout(`${MUSE_MASCOT_ANSI}\n`);
    });
}
