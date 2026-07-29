/**
 * Controlled-live Core100-090 paired arm. Runs two path-scoped workers over
 * the exact frozen Core100-087 fixture/model/budget, then writes a report-only
 * candidate plus paired keep/promote recommendation. Local Ollama only.
 */
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, relative } from "node:path";

import { createFileEditTool, createFileGrepTool, createFileReadTool } from "../packages/fs/dist/index.js";
import {
  createDelegationHandoffLease,
  createRuntimeAgentWorker,
  MultiAgentOrchestrator
} from "../packages/multi-agent/dist/index.js";
import { createEvalRunnerTool, resolveEvalRunnerIsolationSkip } from "./lib/eval-runner-isolation.mjs";
import { createEvalTrialEnvironment } from "./lib/eval-trial-environment.mjs";
import { allowEvalToolCall, createEvalToolExposureAuthority } from "./lib/eval-tool-authority.mjs";
import {
  createEffectBudgetGate,
  createObservedBaselineTool,
  stableSha256,
  summarizeSingleAgentRun,
  writeMultiAgentEvaluationArtifact
} from "./lib/multi-agent-baseline.mjs";
import {
  assessPairedExecution,
  assertCurrentPairedBaseline,
  createCombinedChildRunRecord,
  resolveLocalOllamaBase,
  stagePairedAgentArtifacts
} from "./lib/paired-agent-candidate.mjs";

let OLLAMA_BASE;
try {
  OLLAMA_BASE = resolveLocalOllamaBase(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434");
} catch (cause) {
  console.log(`UNAVAILABLE: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(4);
}
const RUNNER = process.env.MUSE_RUNNER_PATH ?? join(process.cwd(), "target", "release", "muse-runner");
const RESULTS_DIR = process.env.MUSE_MULTI_AGENT_PAIRED_DIR
  ?? join(process.cwd(), ".muse-dev", "evals", "personal-agent-roadmap", "core100-090");
const BASELINE_FILE = process.env.MUSE_MULTI_AGENT_BASELINE_FILE
  ?? join(
    process.cwd(),
    ".muse-dev",
    "evals",
    "personal-agent-roadmap",
    "core100-087",
    "single-agent-two-edit-fix-v1.json"
  );

const ALPHA = `export function alpha() {
  return 1;
}
`;
const BETA = `export function beta() {
  return 10;
}
`;
const NOISE = `export function noise() {
  return "do not touch";
}
`;
const TEST = `import { alpha } from "./src/alpha.mjs";
import { beta } from "./src/beta.mjs";
if (alpha() === 2 && beta() === 20) {
  console.log("TEST PASS");
  process.exit(0);
}
console.error(\`TEST FAIL: alpha() returned \${alpha()}, expected 2 (src/alpha.mjs); beta() returned \${beta()}, expected 20 (src/beta.mjs)\`);
process.exit(1);
`;
const SYSTEM = [
  "You are Muse. Use the file and command tools to do what the user asks.",
  "When a task needs several steps (e.g. read a file, change it, run a command), keep taking the next action after each tool result until it is actually done — do not stop after a single tool call.",
  "If a command or test you run reports a failure, find the cause, fix it with your tools, and run it again to confirm it passes before you answer."
].join(" ");
const TASK_TEMPLATE =
  "The test at <TEST_PATH> is failing. Run it, fix EVERY bug in the source files it tests so the " +
  "test passes, then run it again to confirm. Change only what is necessary.";
const FIXTURE_DEFINITION = {
  alpha: ALPHA,
  beta: BETA,
  noise: NOISE,
  system: SYSTEM,
  task: TASK_TEMPLATE,
  test: TEST
};
const WORKER_TOOLS = Object.freeze(["file_grep", "file_read", "file_edit"]);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function failUnavailable(message) {
  console.log(`UNAVAILABLE: ${message}`);
  process.exit(4);
}

async function runTest(testPath) {
  try {
    execFileSync("node", [testPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

try {
  const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) failUnavailable(`Ollama returned status ${probe.status.toString()}`);
} catch (cause) {
  failUnavailable(`Ollama unreachable (${cause instanceof Error ? cause.message : String(cause)})`);
}
try {
  await access(RUNNER);
} catch {
  failUnavailable(`muse-runner binary not found at ${RUNNER}`);
}
const isolationSkip = resolveEvalRunnerIsolationSkip();
if (isolationSkip) failUnavailable(isolationSkip.message);

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_FILE, "utf8"));
} catch (cause) {
  failUnavailable(`baseline artifact unreadable (${cause instanceof Error ? cause.message : String(cause)})`);
}
const head = git("rev-parse", "HEAD");
const upstream = git("rev-parse", "@{upstream}");
const worktree = git("status", "--porcelain").length === 0 ? "clean" : "dirty";
let budget;
try {
  budget = assertCurrentPairedBaseline({
    baseline,
    fixtureHash: stableSha256(FIXTURE_DEFINITION),
    head,
    upstream,
    worktree
  });
} catch (cause) {
  failUnavailable(cause instanceof Error ? cause.message : String(cause));
}

let trial;
let runFailure;
let result;
const observedToolCalls = [];
const blockedToolCalls = [];
const readPaths = new Set();
const controller = new AbortController();
const parentRunId = `core100-090-multi-${Date.now().toString()}`;
const childRunIds = [`${parentRunId}::alpha`, `${parentRunId}::beta`];
const startedAt = performance.now();
try {
  trial = await createEvalTrialEnvironment({
    overrides: {
      MUSE_ANSWER_TEMPERATURE: "0",
      MUSE_LOCAL_ONLY: "true",
      OLLAMA_BASE_URL: OLLAMA_BASE
    },
    prefix: "muse-two-edit-paired-"
  });
  const dir = trial.fixtureDir;
  await mkdir(join(dir, "src"), { recursive: true });
  const testPath = join(dir, "test.mjs");
  await writeFile(join(dir, "src", "alpha.mjs"), ALPHA);
  await writeFile(join(dir, "src", "beta.mjs"), BETA);
  await writeFile(join(dir, "src", "noise.mjs"), NOISE);
  await writeFile(testPath, TEST);

  const readOptions = {
    baseDir: dir,
    docRoots: [dir],
    onPathRead: (path) => readPaths.add(path),
    roots: [dir]
  };
  const writeOptions = {
    approvalGate: () => ({ approved: true }),
    baseDir: dir,
    checkEditIntegrity: true,
    roots: [dir],
    wasPathRead: (path) => readPaths.has(path)
  };
  const { createMuseRuntimeAssembly } = await import("../packages/autoconfigure/dist/index.js");
  const assembly = createMuseRuntimeAssembly({
    env: trial.env,
    extraTools: [
      createFileGrepTool(readOptions),
      createFileReadTool(readOptions),
      createFileEditTool(writeOptions),
      createEvalRunnerTool({ fixtureRoot: dir, runnerPath: RUNNER })
    ].map((tool) => createObservedBaselineTool(tool, {
      onSettled: (call) => observedToolCalls.push(call),
      signal: controller.signal
    }))
  });
  if (!assembly.agentRuntime || !assembly.modelProvider || !assembly.defaultModel) {
    throw new Error("UNAVAILABLE: no local agent runtime/model configured");
  }
  if (assembly.defaultModel !== baseline.model || assembly.modelProvider.id !== baseline.provider) {
    throw new Error("UNAVAILABLE: candidate model/provider does not exactly match the single-agent baseline");
  }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + budget.wallclockMs + 30_000).toISOString();
  const handoff = {
    contextIndependent: true,
    decomposition: "fanout",
    mergeable: true,
    objective: "Fix two independent source functions under disjoint write scopes",
    schemaVersion: 1,
    sharedState: false,
    subtasks: [
      {
        allowedToolNames: WORKER_TOOLS,
        dependsOn: [],
        effectScopes: [],
        expiresAt,
        id: "alpha",
        input: "Fix alpha only",
        outputSchema: "plain-text completion",
        role: "alpha-fixer",
        writablePaths: ["src/alpha.mjs"]
      },
      {
        allowedToolNames: WORKER_TOOLS,
        dependsOn: [],
        effectScopes: [],
        expiresAt,
        id: "beta",
        input: "Fix beta only",
        outputSchema: "plain-text completion",
        role: "beta-fixer",
        writablePaths: ["src/beta.mjs"]
      }
    ]
  };
  const runtimeFor = (childRunId) => ({
    run: (input) => assembly.agentRuntime.run({ ...input, runId: childRunId })
  });
  const workers = [
    createRuntimeAgentWorker({
      delegationLease: createDelegationHandoffLease(handoff, "alpha", dir, nowIso),
      runtime: runtimeFor(childRunIds[0]),
      spec: {
        description: "Fix the alpha function",
        id: "alpha",
        systemPrompt: "Work only on src/alpha.mjs. Read it, change alpha() to return 2, then stop. Do not touch any other file.",
        toolNames: WORKER_TOOLS
      }
    }),
    createRuntimeAgentWorker({
      delegationLease: createDelegationHandoffLease(handoff, "beta", dir, nowIso),
      runtime: runtimeFor(childRunIds[1]),
      spec: {
        description: "Fix the beta function",
        id: "beta",
        systemPrompt: "Work only on src/beta.mjs. Read it, change beta() to return 20, then stop. Do not touch any other file.",
        toolNames: WORKER_TOOLS
      }
    })
  ];
  const abortTimer = setTimeout(() => controller.abort(), budget.wallclockMs);
  abortTimer.unref();
  const approvalGate = createEffectBudgetGate(budget.maxEffects, async (input) => {
    const decision = await allowEvalToolCall(input);
    if (!decision.allowed) {
      blockedToolCalls.push({
        name: input.toolCall.name,
        risk: input.risk,
        status: "blocked"
      });
    }
    return decision;
  });
  try {
    result = await new MultiAgentOrchestrator({
      workerTimeoutMs: budget.wallclockMs,
      workers
    }).run({
      messages: [
        { content: SYSTEM, role: "system" },
        { content: TASK_TEMPLATE.replace("<TEST_PATH>", testPath), role: "user" }
      ],
      metadata: { localMode: true, userId: "eval-two-edit-fix-paired" },
      model: assembly.defaultModel,
      runId: parentRunId,
      signal: controller.signal,
      toolApprovalGate: async (input) => {
        const decision = await approvalGate(input);
        if (!decision.allowed && !blockedToolCalls.some((call) =>
          call.name === input.toolCall.name
          && call.status === "blocked"
        )) {
          blockedToolCalls.push({
            name: input.toolCall.name,
            risk: input.risk,
            status: "blocked"
          });
        }
        return decision;
      },
      toolExposureAuthority: createEvalToolExposureAuthority("two-edit-fix")
    }, {
      mode: "parallel",
      workerIds: ["alpha", "beta"]
    });
  } catch (cause) {
    runFailure = cause;
  } finally {
    clearTimeout(abortTimer);
  }

  const latencyMs = performance.now() - startedAt;
  const testPasses = await runTest(testPath);
  const alphaFixed = (await readFile(join(dir, "src", "alpha.mjs"), "utf8").catch(() => "")) !== ALPHA;
  const betaFixed = (await readFile(join(dir, "src", "beta.mjs"), "utf8").catch(() => "")) !== BETA;
  const noiseIntact = (await readFile(join(dir, "src", "noise.mjs"), "utf8").catch(() => "")) === NOISE;
  const childRecords = await Promise.all(childRunIds.map((id) => assembly.historyStore.findRun(id)));
  const execution = assessPairedExecution({
    blockedToolCalls,
    childRecords,
    expectedChildRunIds: childRunIds,
    requestedWorkerIds: ["alpha", "beta"],
    result,
    uncertainToolCalls: observedToolCalls.filter((call) =>
      call.risk !== "read"
      && call.status !== "completed"
      && call.status !== "blocked"
    )
  });
  const runRecord = runFailure
    ? undefined
    : createCombinedChildRunRecord(childRecords, execution);
  const summary = summarizeSingleAgentRun({
    latencyMs,
    quality: { alphaFixed, betaFixed, noiseIntact, testPasses },
    runRecord,
    toolCalls: [...observedToolCalls, ...blockedToolCalls],
    toolsUsed: [
      ...new Set(
        result?.results.flatMap((step) => step.result?.toolsUsed ?? [])
        ?? observedToolCalls.map((call) => call.name)
      )
    ]
  });
  const source = {
    baselineArtifactHash: stableSha256(baseline),
    childRunIds,
    head,
    tree: git("rev-parse", "HEAD^{tree}"),
    upstream,
    worktree
  };
  const staged = stagePairedAgentArtifacts({
    baseline,
    candidateInput: {
      contract: baseline.contract,
      generatedAt: new Date().toISOString(),
      model: baseline.model,
      provider: baseline.provider,
      runs: [summary],
      source
    },
    comparisonGeneratedAt: new Date().toISOString(),
    comparisonSource: {
      evaluator: "deterministic-terminal-grader",
      head,
      tree: source.tree
    }
  });
  const { candidate, comparison } = staged;
  const candidatePath = await writeMultiAgentEvaluationArtifact({
    artifact: candidate,
    fileName: "multi-agent-two-edit-fix-v1.json",
    resultsDir: RESULTS_DIR
  });
  const comparisonPath = await writeMultiAgentEvaluationArtifact({
    artifact: comparison,
    fileName: "paired-single-vs-multi-two-edit-fix-v1.json",
    resultsDir: RESULTS_DIR
  });

  console.log(
    `multi-agent candidate: ${summary.quality.passed ? "PASS" : "FAIL"} ` +
    `test=${testPasses.toString()} alpha=${alphaFixed.toString()} beta=${betaFixed.toString()} ` +
    `noise=${noiseIntact.toString()} effects=${summary.effectCount.toString()} latencyMs=${summary.latencyMs.toString()}`
  );
  if (runFailure) {
    console.log(`candidate failure: ${runFailure instanceof Error ? runFailure.message : String(runFailure)}`);
  }
  console.log(`candidate artifact: ${relative(process.cwd(), candidatePath)}`);
  console.log(`comparison artifact: ${relative(process.cwd(), comparisonPath)}`);
  console.log(`paired decision: ${comparison.decision.outcome} [${comparison.decision.reasonCodes.join(",")}]`);
  process.exitCode = summary.quality.passed ? 0 : 1;
} catch (cause) {
  if (cause instanceof Error && cause.message.startsWith("UNAVAILABLE:")) {
    console.log(cause.message);
    process.exitCode = 4;
  } else {
    throw cause;
  }
} finally {
  await trial?.dispose();
}
