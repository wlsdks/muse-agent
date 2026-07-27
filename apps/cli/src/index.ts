#!/usr/bin/env node
// Enable the V8 compile cache before any other module in the graph — see
// compile-cache.ts for why this must stay the first import.
import "./compile-cache.js";
import { trySpecFastPath } from "./muse-spec.js";
import { tryVersionFastPath } from "./muse-version.js";

// Reject an oversized argv BEFORE any heavy module import. A ~950k-char arg sits
// near V8's synchronous stack ceiling, and program.js's ~100-module ESM linking
// then tips over into a raw `RangeError: Maximum call stack size exceeded`. This
// check is deliberately INLINE and dependency-free — importing the shared
// `assertArgvWithinLimit` (from program-helpers) would drag that helper's own
// module graph into index's static linking, which overflows first, before the
// guard could run. Keep the two in sync; program-helpers' export is the
// unit-tested twin. Threshold (800k) is safely below the observed ~900k cliff.
{
  let argvChars = 0;
  for (const arg of process.argv) {
    argvChars += typeof arg === "string" ? arg.length : 0;
  }
  if (argvChars > 800_000) {
    process.stderr.write(
      `muse: input too large (${argvChars.toString()} chars) — pass large content via stdin ` +
        "(e.g. `muse ask \"$(cat file)\"` → `cat file | muse ask`) instead of a command-line argument.\n"
    );
    process.exit(1);
  }
}

// Handle the trivial `muse --version` / `muse spec` probes BEFORE importing the
// command framework, so these common invocations skip the ~100-module graph.
const fastWrite = (text: string) => process.stdout.write(text);
if (tryVersionFastPath(process.argv, fastWrite) || trySpecFastPath(process.argv, fastWrite)) {
  process.exit(0);
}

const terminalContract = await import("./cli-terminal-state.js");
const jsonRequested = terminalContract.jsonModeRequested(process.argv);
let stdoutWritten = false;
let bufferedStderr = "";
const programIo = {
  stderr: (message: string) => {
    bufferedStderr += message;
  },
  stdout: (message: string) => {
    stdoutWritten ||= message.length > 0;
    process.stdout.write(message);
  },
  workspaceDir: process.cwd()
};

try {
  const { createProgram } = await import("./program.js");
  const program = createProgram(programIo);
  // Production owns Commander termination so every parser/argument failure
  // reaches the same terminal-state classifier instead of calling exit early.
  program.exitOverride();
  await program.parseAsync(process.argv);

  const state = terminalContract.terminalStateFromExitCode(process.exitCode);
  if (bufferedStderr.trim().length > 0) {
    if (jsonRequested && state !== "success" && !stdoutWritten) {
      process.stdout.write(terminalContract.jsonTerminalFailure(
        new terminalContract.CliTerminalStateError(state, bufferedStderr.trim()),
        state,
        { command: terminalContract.commandNameFromArgv(process.argv) }
      ));
    } else if (!jsonRequested) {
      process.stderr.write(bufferedStderr);
    }
  }
} catch (error) {
  const [{ formatCliError }, { MUSE_CLI_VERSION }] = await Promise.all([
    import("./format-cli-error.js"),
    import("./muse-version.js")
  ]);
  const state = terminalContract.classifyCliTerminalState(error);
  if (state === "success") {
    process.exitCode = 0;
  } else {
    const command = terminalContract.commandNameFromArgv(process.argv);
    if (jsonRequested && !stdoutWritten) {
      process.stdout.write(terminalContract.jsonTerminalFailure(error, state, {
        command,
        fallbackMessage: bufferedStderr
      }));
    } else if (!jsonRequested) {
      process.stderr.write(formatCliError(error, {
        command,
        version: MUSE_CLI_VERSION
      }));
    }
    process.exitCode = terminalContract.cliExitCode(state);
  }
}
