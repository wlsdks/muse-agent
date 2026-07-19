/**
 * Capability-oriented live agent evaluation.
 *
 * Every row must emit one versioned completion marker. Exit zero without that
 * evidence is a failure, and stochastic rows pass only when all three requested
 * trials executed and passed. `--json` keeps stdout machine-only and never
 * copies prompts, model output, or tool payloads into the report.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifySkip, parseCompletion } from "./eval-skip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_REPORT_PATH = resolve(here, "../.muse-dev/evals/agent-capability/latest.json");

export const CAPABILITIES = Object.freeze([
  { id: "tool-selection-arguments", battery: "eval-tool-selection.mjs", required: true, repeats: 3 },
  { id: "plan-quality", battery: "eval-plan-quality.mjs", required: true, repeats: 3 },
  { id: "tool-argument-grounding", battery: "../apps/cli/scripts/verify-tool-arg-grounding.mjs", required: true, repeats: 3 },
  { id: "computer-task-terminal-edit", battery: "eval-computer-task.mjs", required: true, repeats: 3 },
  { id: "adversarial-containment-no-op", battery: "eval-adversarial.mjs", required: true, repeats: 3 },
  { id: "cosine-recall-abstention", battery: "eval-recall-quality.mjs", required: true, repeats: 1 },
  { id: "multihop-retrieval-lift", battery: "verify-multihop.mjs", required: true, repeats: 1 },
  { id: "orchestration-failure-bounds", battery: "verify-orchestration.mjs", required: true, repeats: 3 },
  { id: "channel-conversation-rhythm", battery: "eval-channel-rhythm.mjs", required: true, repeats: 3 },
  { id: "edit-run-verify", battery: "eval-edit-run-verify.mjs", required: false, repeats: 3 },
  { id: "browser-terminal-task", battery: "eval-browser-agent.mjs", required: false, repeats: 3 },
]);

const RECOGNIZED_ENVIRONMENT_SKIPS = new Set([
  "chrome-missing",
  "embed-model-missing",
  "model-missing",
  "ollama-unreachable",
  "runner-missing",
  "runtime-unavailable",
  "sandbox-missing",
]);

function failedRow(capability, durationMs, reason, executed = 0) {
  return {
    id: capability.id,
    required: capability.required,
    status: "failed",
    requested: capability.repeats,
    executed,
    reason,
    durationMs,
  };
}

/** Convert a child-process result into a privacy-safe, fail-closed row. */
export function classifyCapabilityResult(capability, child) {
  const durationMs = Math.max(0, Math.round(child.durationMs ?? 0));
  if (child.error) {
    return failedRow(capability, durationMs, "spawn-error");
  }
  if (child.signal) {
    return failedRow(capability, durationMs, "signal");
  }
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const parsed = parseCompletion(output);
  if (child.status !== 0) {
    return failedRow(
      capability,
      durationMs,
      "exit-nonzero",
      parsed.ok ? parsed.completion.executed : 0
    );
  }

  if (!parsed.ok) {
    return failedRow(capability, durationMs, parsed.reason);
  }

  const { completion } = parsed;
  if (completion.requested !== capability.repeats) {
    return failedRow(capability, durationMs, "requested-repeat-mismatch", completion.executed);
  }

  const skipCode = classifySkip(output);
  if (completion.status === "passed") {
    if (skipCode) {
      return failedRow(capability, durationMs, "unexpected-skip", completion.executed);
    }
    return {
      id: capability.id,
      required: capability.required,
      status: "passed",
      requested: capability.repeats,
      executed: completion.executed,
      durationMs,
    };
  }

  if (completion.status === "failed") {
    return failedRow(capability, durationMs, "battery-reported-failure", completion.executed);
  }

  if (!skipCode || !RECOGNIZED_ENVIRONMENT_SKIPS.has(skipCode)) {
    return failedRow(capability, durationMs, skipCode ? "unrecognized-skip" : "missing-skip-evidence", completion.executed);
  }
  if (completion.reason !== skipCode) {
    return failedRow(capability, durationMs, "skip-reason-mismatch", completion.executed);
  }
  return {
    id: capability.id,
    required: capability.required,
    status: "unverified",
    requested: capability.repeats,
    executed: completion.executed,
    reason: completion.reason,
    durationMs,
  };
}

/** Build the stable JSON schema and compute the required-row gate. */
export function createCapabilityReport(capabilities) {
  const counts = {
    passed: capabilities.filter((row) => row.status === "passed").length,
    failed: capabilities.filter((row) => row.status === "failed").length,
    unverified: capabilities.filter((row) => row.status === "unverified").length,
    total: capabilities.length,
  };
  const required = capabilities.filter((row) => row.required);
  const status = capabilities.some((row) => row.status === "failed")
    ? "failed"
    : required.some((row) => row.status !== "passed")
      ? "unverified"
      : "passed";
  return { version: 1, status, counts, capabilities };
}

/** Persist only the privacy-safe aggregate, atomically, under the ignored eval tree. */
export function persistCapabilityReport(report, reportPath = DEFAULT_REPORT_PATH) {
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.${process.pid.toString()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, reportPath);
}

function printHumanReport(report, stdout) {
  stdout.write("\n=== eval:agent capability summary ===\n");
  for (const row of report.capabilities) {
    const tag = row.status === "passed" ? "PASS" : row.status === "failed" ? "FAIL" : "UNVERIFIED";
    const reason = row.reason ? ` (${row.reason})` : "";
    stdout.write(`  ${tag.padEnd(10)} ${row.id} ${row.executed}/${row.requested}${reason}\n`);
  }
  stdout.write(
    `eval:agent ${report.status.toUpperCase()} — ${report.counts.passed} pass, ${report.counts.unverified} unverified, ${report.counts.failed} fail\n`
  );
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const spawn = dependencies.spawn ?? spawnSync;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const now = dependencies.now ?? Date.now;
  const json = args.includes("--json");
  const rows = [];

  for (const capability of CAPABILITIES) {
    const startedAt = now();
    if (json) {
      stderr.write(`eval:agent running ${capability.id}\n`);
    } else {
      stdout.write(`\n=== eval:agent → ${capability.id} ===\n`);
    }
    const child = spawn(process.execPath, [join(here, capability.battery)], {
      encoding: "utf8",
      env: { ...process.env, MUSE_EVAL_REPEAT: String(capability.repeats) },
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CAPABILITY_TIMEOUT_MS,
    });
    const withDuration = { ...child, durationMs: now() - startedAt };
    if (!json) {
      stdout.write(child.stdout ?? "");
      stderr.write(child.stderr ?? "");
    }
    const row = classifyCapabilityResult(capability, withDuration);
    rows.push(row);
    if (json) {
      stderr.write(`eval:agent ${capability.id} ${row.status}\n`);
    }
  }

  const report = createCapabilityReport(rows);
  dependencies.writeReport?.(report);
  if (json) {
    stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    printHumanReport(report, stdout);
  }
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { writeReport: persistCapabilityReport });
}
