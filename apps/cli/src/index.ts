#!/usr/bin/env node
import { trySpecFastPath } from "./muse-spec.js";
import { tryVersionFastPath } from "./muse-version.js";

// Handle the trivial `muse --version` / `muse spec` probes BEFORE importing the
// command framework, so these common invocations skip the ~100-module graph.
const fastWrite = (text: string) => process.stdout.write(text);
if (tryVersionFastPath(process.argv, fastWrite) || trySpecFastPath(process.argv, fastWrite)) {
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
