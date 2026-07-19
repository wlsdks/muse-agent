/**
 * eval:run-command — the EXECUTE path on the live local model.
 *
 * file_edit/grep prove Muse can NAVIGATE+MUTATE files; this proves gemma4 can
 * actually RUN a command through the Rust runner (`crates/runner`) and use its
 * output — the other half of "controlling the computer". Graded on the TERMINAL
 * STATE / grounded answer (agent-testing.md): a fixture Node script prints a
 * unique diagnostic token that exists ONLY in its runtime output, so a
 * fabricated "I ran it" cannot pass — the answer must carry the real token,
 * which only a genuine execution reveals, and run_command must have been called.
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or the muse-runner binary is
 * unavailable.  MUSE_EVAL_REPEAT=3 node scripts/eval-run-command.mjs   # pass^k
 */
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { completionLine, skipLine } from "./eval-skip.mjs";
import { createEvalRunnerTool, resolveEvalRunnerIsolationSkip } from "./lib/eval-runner-isolation.mjs";
import { createEvalTrialEnvironment } from "./lib/eval-trial-environment.mjs";
import { allowEvalToolCall, createEvalToolExposureAuthority } from "./lib/eval-tool-authority.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));
const RUNNER = process.env.MUSE_RUNNER_PATH ?? join(process.cwd(), "target", "release", "muse-runner");

try {
  const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`status ${probe.status}`);
} catch (cause) {
  console.log(`SKIP: Ollama unreachable (${cause instanceof Error ? cause.message : cause})`);
  process.exit(0);
}
try {
  await access(RUNNER);
} catch {
  console.log(`SKIP: muse-runner binary not found at ${RUNNER} (build it: cargo build --release -p muse-runner)`);
  process.exit(0);
}
const isolationSkip = resolveEvalRunnerIsolationSkip();
if (isolationSkip) {
  console.log(`SKIP: ${isolationSkip.message}`);
  console.log(skipLine(isolationSkip.code, isolationSkip.message));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason: isolationSkip.code }));
  process.exit(0);
}

const TOKEN = "QX7F3A92";
const SCRIPT = `console.log("diagnostic code: ${TOKEN}");\n`;

const logTool = (tool) => ({
  ...tool,
  execute: async (args, ctx) => {
    let result;
    try {
      result = await tool.execute(args, ctx);
    } catch (cause) {
      if (process.env.MUSE_TASK_DEBUG) {
        console.log(`  [tool-error] ${tool.definition.name}(${JSON.stringify(args).slice(0, 160)}) → ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      throw cause;
    }
    if (process.env.MUSE_TASK_DEBUG) {
      console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args).slice(0, 160)}) → ${JSON.stringify(result).slice(0, 160)}`);
    }
    return result;
  }
});

let failures = 0;
let runtimeUnavailable = false;
let dir;
let trial;
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    await trial?.dispose();
    trial = await createEvalTrialEnvironment({ prefix: "muse-run-command-" });
    dir = trial.fixtureDir;
    const scriptPath = join(dir, "report.mjs");
    await writeFile(scriptPath, SCRIPT);

    const { createMuseRuntimeAssembly } = await import("../packages/autoconfigure/dist/index.js");
    const assembly = createMuseRuntimeAssembly({
      env: trial.env,
      extraTools: [createEvalRunnerTool({ fixtureRoot: dir, runnerPath: RUNNER })].map(logTool)
    });
    if (!assembly.agentRuntime || !assembly.modelProvider) {
      console.log("SKIP: no agent runtime/model configured");
      runtimeUnavailable = true;
      break;
    }

    const TASK =
      `Run the Node script at ${scriptPath} (command "node" with that file as the argument) ` +
      "and tell me the diagnostic code it prints.";
    const result = await assembly.agentRuntime.run({
      messages: [
        { content: "You are Muse. Use the run_command tool to execute what the user asks, then answer from the command output.", role: "system" },
        { content: TASK, role: "user" }
      ],
      // localMode arms the execute-risk run_command (the CLI sets this under --actuators).
      metadata: { localMode: true, userId: "eval-run-command" },
      model: assembly.defaultModel,
      toolApprovalGate: allowEvalToolCall,
      toolExposureAuthority: createEvalToolExposureAuthority("run-command")
    });
    const answer = result.response?.output ?? "";
    const toolsUsed = result.toolsUsed ?? [];
    const ranCommand = toolsUsed.includes("run_command");
    const answerHasToken = answer.includes(TOKEN);
    const ok = ranCommand && answerHasToken;
    if (!ok) failures += 1;
    console.log(`run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ran-command=${ranCommand.toString()} token-in-answer=${answerHasToken.toString()} tools=[${toolsUsed.join(",")}]`);
    if (!ok) console.log(`  answer: ${answer.slice(0, 240)}`);
  }
} finally {
  await trial?.dispose();
}

if (runtimeUnavailable) process.exit(0);

if (failures > 0) {
  console.log(`\neval:run-command FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed`);
  process.exit(1);
}
console.log(`\neval:run-command PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — real execution, grounded token in answer)`);
