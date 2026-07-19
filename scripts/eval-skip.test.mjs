// Deterministic unit tests for the eval skip-telemetry helpers.
// Run: node --test scripts/eval-skip.test.mjs   (zero deps, no Ollama)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyOutcome,
  classifySkip,
  completionLine,
  parseCompletion,
  skipLine,
  COMPLETION_MARKER,
  SKIP_MARKER,
} from "./eval-skip.mjs";

test("completion contract: a versioned marker round-trips without payload data", () => {
  const line = completionLine({ status: "passed", requested: 3, executed: 3 });
  assert.match(line, new RegExp(`^${COMPLETION_MARKER}:`, "u"));
  assert.deepEqual(parseCompletion(line), {
    ok: true,
    completion: { version: 1, status: "passed", requested: 3, executed: 3 },
  });
});

test("completion contract: missing, duplicate, and malformed evidence fail closed", () => {
  assert.deepEqual(parseCompletion("ordinary successful output"), {
    ok: false,
    reason: "missing-completion",
  });

  const valid = completionLine({ status: "unverified", requested: 3, executed: 0, reason: "ollama-unreachable" });
  assert.deepEqual(parseCompletion(`${valid}\n${valid}`), {
    ok: false,
    reason: "duplicate-completion",
  });
  assert.deepEqual(parseCompletion(`${COMPLETION_MARKER}:{\"version\":1,\"status\":\"passed\",\"requested\":3}`), {
    ok: false,
    reason: "invalid-completion",
  });
});

test("completion contract: rejects unstable or contradictory completion fields", () => {
  assert.throws(
    () => completionLine({ status: "passed", requested: 3, executed: 2 }),
    /executed must equal requested/u
  );
  assert.throws(
    () => completionLine({ status: "unverified", requested: 3, executed: 0, reason: "free form reason" }),
    /stable reason code/u
  );
  assert.throws(
    () => completionLine({ status: "unverified", requested: 3, executed: 1, reason: "runtime-unavailable" }),
    /before any trial executes/u
  );
});

test("classifySkip: a battery that ran (no skip notice) returns null → not a skip", () => {
  assert.equal(classifySkip("PASS — cited recall\nALL PASS (2) on ollama/gemma4:12b"), null);
  // a passing battery that merely reports internally-skipped CASES is not a skipped battery
  assert.equal(classifySkip("ran 5 cases, 2 skipped on timeout\nALL PASS"), null);
  assert.equal(classifySkip(""), null);
});

test("classifySkip: the crisp marker wins and carries its code", () => {
  assert.equal(classifySkip(skipLine("chrome-missing", "no Chrome on PATH")), "chrome-missing");
  assert.equal(classifySkip(`noise\n${SKIP_MARKER}:embed-model-missing pull nomic\nmore`), "embed-model-missing");
});

test("classifySkip: legacy Ollama-down phrasing → ollama-unreachable", () => {
  assert.equal(
    classifySkip("verify-cited-recall skipped — local Ollama not reachable at http://localhost:11434. A skip is not a pass."),
    "ollama-unreachable"
  );
});

test("classifySkip: legacy embed-model phrasings → embed-model-missing", () => {
  assert.equal(
    classifySkip("verify-cited-recall skipped — embed model 'nomic-embed-text-v2-moe' unavailable (fetch failed). Try: ollama pull nomic-embed-text-v2-moe"),
    "embed-model-missing"
  );
  assert.equal(classifySkip("eval:recall-quality skipped — embedder unavailable (connect ECONNREFUSED)."), "embed-model-missing");
  assert.equal(classifySkip("verify-grounded-recall-seam skipped — embedding produced no index (embed endpoint failing). A skip is not a pass."), "embed-model-missing");
});

test("classifyOutcome: a non-zero exit is a fail regardless of stdout", () => {
  assert.equal(classifyOutcome({ exitCode: 1, skipCode: null }), "fail");
  assert.equal(classifyOutcome({ exitCode: 1, skipCode: "ollama-unreachable" }), "fail");
});

test("classifyOutcome: a real pass (exit 0, no skip) is ok", () => {
  assert.equal(classifyOutcome({ exitCode: 0, skipCode: null }), "ok");
});

test("classifyOutcome: an Ollama/Chrome-down skip is a genuine skip, not ok and not fail", () => {
  assert.equal(classifyOutcome({ exitCode: 0, skipCode: "ollama-unreachable" }), "skip");
  assert.equal(classifyOutcome({ exitCode: 0, skipCode: "chrome-missing" }), "skip");
});

test("classifyOutcome: skipping on a MISSING EMBED MODEL while Ollama is up is a FAIL (nomic-not-pulled incident)", () => {
  // This is the load-bearing assertion: an embed-model skip must NOT launder to
  // "ok" or even "skip" — the box has Ollama up and just needs `ollama pull`.
  assert.equal(classifyOutcome({ exitCode: 0, skipCode: "embed-model-missing" }), "fail");
});
