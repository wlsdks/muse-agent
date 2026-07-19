import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveToolExposureAuthority } from "../packages/policy/dist/index.js";
import { allowEvalToolCall, createEvalToolExposureAuthority } from "./lib/eval-tool-authority.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_TOOLS = ["file_grep", "file_read", "file_edit"];
const cases = [
  { id: "browser-agent", file: "scripts/eval-browser-agent.mjs", allowedToolNames: ["browser_read", "browser_type", "browser_click"] },
  { id: "computer-task", file: "scripts/eval-computer-task.mjs", allowedToolNames: FILE_TOOLS },
  { id: "edit-run-verify", file: "scripts/eval-edit-run-verify.mjs", allowedToolNames: [...FILE_TOOLS, "run_command"] },
  { id: "multifile-fix", file: "scripts/eval-multifile-fix.mjs", allowedToolNames: [...FILE_TOOLS, "run_command"] },
  { id: "two-edit-fix", file: "scripts/eval-two-edit-fix.mjs", allowedToolNames: [...FILE_TOOLS, "run_command"] },
  { id: "reverify-fix", file: "scripts/eval-reverify-fix.mjs", allowedToolNames: [...FILE_TOOLS, "run_command"] },
  { id: "run-command", file: "scripts/eval-run-command.mjs", allowedToolNames: ["run_command"] },
  { id: "tool-arg-grounding", file: "apps/cli/scripts/verify-tool-arg-grounding.mjs", allowedToolNames: ["muse.calendar.add"] },
];

test("multi-step eval authority uses the exact per-battery positive allowlist", () => {
  for (const entry of cases) {
    assert.deepEqual(resolveToolExposureAuthority(createEvalToolExposureAuthority(entry.id)), {
      allowedToolNames: entry.allowedToolNames,
      localMode: true,
    });
  }
  assert.throws(() => createEvalToolExposureAuthority("unknown-battery"), /unknown multi-step eval battery/u);
});

test("every live multi-step battery passes exactly one minted authority into AgentRuntime", () => {
  for (const entry of cases) {
    const source = readFileSync(join(ROOT, entry.file), "utf8");
    const assignments = source.match(/\btoolExposureAuthority\s*:/gu) ?? [];
    const approvalGates = source.match(/\btoolApprovalGate\s*:/gu) ?? [];
    assert.equal(assignments.length, 1, `${entry.file} must pass exactly one toolExposureAuthority`);
    assert.equal(approvalGates.length, 1, `${entry.file} must pass exactly one run-scoped toolApprovalGate`);
    assert.doesNotMatch(
      source,
      /metadata\s*:\s*\{[^}]*toolExposureAuthority\s*:/su,
      `${entry.file} must pass toolExposureAuthority at AgentRunInput top level, never inside inert metadata`
    );
    assert.match(
      source,
      new RegExp(`toolExposureAuthority\\s*:\\s*createEvalToolExposureAuthority\\(\"${entry.id}\"\\)`, "u"),
      `${entry.file} must use its exact shared authority profile`
    );
    assert.match(source, /toolApprovalGate\s*:\s*allowEvalToolCall/u, `${entry.file} must use the eval-only approval decision`);
    assert.doesNotMatch(source, /\bcreateToolExposureAuthority\b/u, `${entry.file} must not mint or widen authority inline`);
  }
});

test("eval-only approval allows the isolated call without observing or logging its payload", () => {
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args);
  console.error = (...args) => logged.push(args);
  try {
    assert.deepEqual(allowEvalToolCall({
      risk: "write",
      runId: "private-run",
      toolCall: { arguments: { secret: "must-not-log" }, id: "private-call", name: "file_edit" },
    }), { allowed: true });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(logged, []);
});

test("browser eval keeps fixture navigation outside the registered model tool set", () => {
  const source = readFileSync(join(ROOT, "scripts/eval-browser-agent.mjs"), "utf8");
  assert.match(source, /await controller\.open\(url\)/u, "fixture setup must navigate directly through the controller");
  assert.doesNotMatch(source, /\bcreateBrowserOpenTool\b/u, "browser_open must not be registered or imported");
  assert.doesNotMatch(source, /\bcreateBrowserBackTool\b/u, "browser_back must not be registered or imported");
});
