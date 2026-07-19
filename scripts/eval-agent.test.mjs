import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CAPABILITIES,
  classifyCapabilityResult,
  createCapabilityReport,
  main,
  persistCapabilityReport,
} from "./eval-agent.mjs";
import { completionLine, skipLine } from "./eval-skip.mjs";

const stochastic = CAPABILITIES[0];

function result(stdout, overrides = {}) {
  return {
    status: 0,
    signal: null,
    error: undefined,
    stdout,
    stderr: "",
    durationMs: 17,
    ...overrides,
  };
}

test("capability matrix is stable, ordered, and uses strict pass^3 where required", () => {
  assert.deepEqual(
    CAPABILITIES.map(({ id, required, repeats }) => ({ id, required, repeats })),
    [
      { id: "tool-selection-arguments", required: true, repeats: 3 },
      { id: "plan-quality", required: true, repeats: 3 },
      { id: "tool-argument-grounding", required: true, repeats: 3 },
      { id: "computer-task-terminal-edit", required: true, repeats: 3 },
      { id: "adversarial-containment-no-op", required: true, repeats: 3 },
      { id: "cosine-recall-abstention", required: true, repeats: 1 },
      { id: "multihop-retrieval-lift", required: true, repeats: 1 },
      { id: "orchestration-failure-bounds", required: true, repeats: 3 },
      { id: "channel-conversation-rhythm", required: true, repeats: 3 },
      { id: "edit-run-verify", required: false, repeats: 3 },
      { id: "browser-terminal-task", required: false, repeats: 3 },
    ]
  );
});

test("plan-quality threshold is pinned to one and cannot be weakened by environment", () => {
  const source = readFileSync(new URL("./eval-plan-quality.mjs", import.meta.url), "utf8");
  assert.match(source, /const THRESHOLD = 1;/u);
  assert.doesNotMatch(source, /process\.env\.MUSE_EVAL_THRESHOLD/u);
});

test("exit zero without explicit completion evidence fails closed", () => {
  assert.deepEqual(classifyCapabilityResult(stochastic, result("looks good\nPASS")), {
    id: stochastic.id,
    required: true,
    status: "failed",
    requested: 3,
    executed: 0,
    reason: "missing-completion",
    durationMs: 17,
  });
});

test("a capability passes only when the requested and executed repeat counts match", () => {
  const passed = completionLine({ status: "passed", requested: 3, executed: 3 });
  assert.equal(classifyCapabilityResult(stochastic, result(passed)).status, "passed");

  const wrongRequest = completionLine({ status: "passed", requested: 1, executed: 1 });
  assert.equal(classifyCapabilityResult(stochastic, result(wrongRequest)).reason, "requested-repeat-mismatch");
});

test("only a matching, recognized environmental skip can be unverified", () => {
  const completion = completionLine({
    status: "unverified",
    requested: 3,
    executed: 0,
    reason: "ollama-unreachable",
  });
  const recognized = `${skipLine("ollama-unreachable", "local provider down")}\n${completion}`;
  assert.equal(classifyCapabilityResult(stochastic, result(recognized)).status, "unverified");

  const unknown = `${skipLine("something-else", "not evidence")}\n${completion}`;
  assert.equal(classifyCapabilityResult(stochastic, result(unknown)).reason, "unrecognized-skip");

  const mismatch = `${skipLine("runner-missing", "not installed")}\n${completion}`;
  assert.equal(classifyCapabilityResult(stochastic, result(mismatch)).reason, "skip-reason-mismatch");

  for (const reason of ["chrome-missing", "model-missing"]) {
    const environmental = `${skipLine(reason, "preflight unavailable")}\n${completionLine({
      status: "unverified",
      requested: 3,
      executed: 0,
      reason,
    })}`;
    assert.equal(classifyCapabilityResult(stochastic, result(environmental)).status, "unverified");
  }
});

test("spawn errors, signals, non-zero exits, and contradictory pass markers fail", () => {
  const passed = completionLine({ status: "passed", requested: 3, executed: 3 });
  assert.equal(
    classifyCapabilityResult(stochastic, result("", { error: new Error("secret spawn details") })).reason,
    "spawn-error"
  );
  assert.equal(classifyCapabilityResult(stochastic, result("", { status: null, signal: "SIGTERM" })).reason, "signal");
  const nonZero = classifyCapabilityResult(stochastic, result(passed, { status: 2 }));
  assert.equal(nonZero.reason, "exit-nonzero");
  assert.equal(nonZero.executed, 3, "a real failed pass^k run must retain its executed-trial evidence");
  assert.equal(
    classifyCapabilityResult(stochastic, result(`${skipLine("ollama-unreachable")}\n${passed}`)).reason,
    "unexpected-skip"
  );
});

test("overall status considers every executed failure and JSON output contains no child payloads", () => {
  const rows = CAPABILITIES.map((capability) => ({
    id: capability.id,
    required: capability.required,
    status: capability.required ? "passed" : "unverified",
    requested: capability.repeats,
    executed: capability.required ? capability.repeats : 0,
    ...(capability.required ? {} : { reason: "runner-missing" }),
    durationMs: 11,
  }));
  const report = createCapabilityReport(rows);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.counts, { passed: 9, failed: 0, unverified: 2, total: 11 });
  assert.deepEqual(Object.keys(report), ["version", "status", "counts", "capabilities"]);

  const encoded = JSON.stringify(report);
  assert.doesNotMatch(encoded, /prompt|output|payload|secret spawn details/iu);

  rows[0] = { ...rows[0], status: "unverified", executed: 0, reason: "ollama-unreachable" };
  assert.equal(createCapabilityReport(rows).status, "unverified");
  rows[1] = { ...rows[1], status: "failed", executed: 0, reason: "missing-completion" };
  assert.equal(createCapabilityReport(rows).status, "failed");

  const optional = CAPABILITIES.findIndex((capability) => !capability.required);
  const otherwisePassing = CAPABILITIES.map((capability) => ({
    id: capability.id,
    required: capability.required,
    status: "passed",
    requested: capability.repeats,
    executed: capability.repeats,
    durationMs: 1,
  }));
  otherwisePassing[optional] = {
    ...otherwisePassing[optional],
    status: "failed",
    reason: "terminal-state-failed",
  };
  assert.equal(createCapabilityReport(otherwisePassing).status, "failed");
});

test("marker mutation: fail and environmental skip cannot be mistaken for pass", () => {
  const failed = completionLine({ status: "failed", requested: 3, executed: 3, reason: "threshold-not-met" });
  assert.equal(classifyCapabilityResult(stochastic, result(failed)).status, "failed");

  const skipped = `${skipLine("model-missing", "model not installed")}\n${completionLine({
    status: "unverified",
    requested: 3,
    executed: 0,
    reason: "model-missing",
  })}`;
  assert.equal(classifyCapabilityResult(stochastic, result(skipped)).status, "unverified");
  assert.equal(
    classifyCapabilityResult(stochastic, result(skipped.replace('"status":"unverified"', '"status":"passed"'))).status,
    "failed"
  );
});

test("--json keeps stdout JSON-only, redirects safe progress, and enforces repeat env", () => {
  let stdout = "";
  let stderr = "";
  let clock = 0;
  const repeats = [];
  const timeouts = [];
  const killSignals = [];
  const fakeSpawn = (_command, _args, options) => {
    const requested = Number(options.env.MUSE_EVAL_REPEAT);
    repeats.push(requested);
    timeouts.push(options.timeout);
    killSignals.push(options.killSignal);
    return {
      status: 0,
      signal: null,
      stdout: `${completionLine({ status: "passed", requested, executed: requested })}\nPRIVATE_CHILD_PAYLOAD`,
      stderr: "PRIVATE_CHILD_ERROR",
    };
  };

  const report = main(["--json"], {
    spawn: fakeSpawn,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    now: () => clock++,
  });

  assert.deepEqual(JSON.parse(stdout), report);
  assert.deepEqual(repeats, [3, 3, 3, 3, 3, 1, 1, 3, 3, 3, 3]);
  assert.equal(timeouts.length, CAPABILITIES.length);
  assert.ok(timeouts.every((timeout) => timeout === 90 * 60 * 1000));
  assert.deepEqual(killSignals, Array(CAPABILITIES.length).fill("SIGKILL"));
  assert.doesNotMatch(stdout, /PRIVATE_CHILD|eval:agent running/u);
  assert.doesNotMatch(stderr, /PRIVATE_CHILD/u);
  assert.match(stderr, /eval:agent running tool-selection-arguments/u);
});

test("privacy-safe aggregate evidence is persisted atomically with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-agent-report-"));
  const reportPath = join(dir, "nested", "latest.json");
  const report = createCapabilityReport([]);
  persistCapabilityReport(report, reportPath);

  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), report);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o077, 0);
});

test("a required environmental skip makes the strict aggregate process exit nonzero", () => {
  let stdout = "";
  let invocation = 0;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = main(["--json"], {
      spawn: (_command, _args, options) => {
        const capability = CAPABILITIES[invocation++];
        assert.ok(capability);
        const requested = Number(options.env.MUSE_EVAL_REPEAT);
        const completion = capability.id === "tool-selection-arguments"
          ? `${skipLine("ollama-unreachable", "local provider down")}\n${completionLine({
              status: "unverified",
              requested,
              executed: 0,
              reason: "ollama-unreachable",
            })}`
          : completionLine({ status: "passed", requested, executed: requested });
        return { signal: null, status: 0, stderr: "", stdout: completion };
      },
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} },
      now: () => 0,
    });

    assert.equal(report.status, "unverified");
    assert.equal(JSON.parse(stdout).status, "unverified");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
