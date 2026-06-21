#!/usr/bin/env node
import { tryVersionFastPath } from "./muse-version.js";

// Handle the trivial `muse --version` probe BEFORE importing the command
// framework, so the most-common invocation skips the ~100-module graph.
if (tryVersionFastPath(process.argv, (text) => process.stdout.write(text))) {
  process.exit(0);
}

try {
  const { createProgram } = await import("./program.js");
  await createProgram().parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`muse: ${message}\n`);
  process.exit(1);
}
