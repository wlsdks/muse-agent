#!/usr/bin/env node
// guard-review-tier — make "record which tier was used" a checked fact.
//
// `.claude/harness/contract.md` §3.6 and `.claude/rules/engineering/harness.md` both say
// "Record which tier was used in the commit body — this is not optional ceremony", and
// `.claude/rules/engineering/commits.md` conditions the standing push authorization on
// "evaluator PASS". Neither was checked anywhere: `review-tier` appeared in no script, so
// "the evaluator passed" was a claim nobody could audit — the exact failure mode HANDBOOK.md
// names (reporting compliance that did not happen).
//
// This does NOT verify that an evaluation happened; nothing can. It forces the claim to be
// stated in a fixed vocabulary so a reader can check it against the diff, and it refuses the
// strongest claim on the riskiest diffs unless the strongest tier is named.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const TIERS = ["independent-evaluator", "thin-review", "n/a"];

/**
 * Surfaces where `.claude/rules/engineering/harness.md` §2 makes a separate-instance
 * evaluator unconditional.
 *
 * The keyword may appear ANYWHERE in the path, not just as the first basename token. The
 * first version anchored it to the start of the basename and therefore let
 * `channel-approval-gate.ts` and `chat-approval-gate.ts` — the actual fail-close send gates —
 * through with a thin review, while blocking an `approval-gate.ts` that does not exist in
 * this repo. Two other patterns (`migrations/`, `*.sql`) matched zero real paths. Verified
 * against `git ls-files` when changing this list; a pattern that matches nothing is a lie.
 */
export const MANDATORY_EVALUATOR_PATTERNS = [
  // security / permission / outbound
  /[\w-]*(approval|consent|credential|secret|auth|policy|guard|egress|outbound|permission)[\w-]*\.[cm]?tsx?$/u,
  // on-disk / persisted formats
  /[\w-]*(checkpoint|migration|store-schema|encrypted-file)[\w-]*\.[cm]?tsx?$/u,
  // the gates themselves, and the hooks that run them
  /(^|\/)scripts\/githooks\//u,
  /(^|\/)scripts\/(guard|check)-[\w-]+\.mjs$/u,
  // packages whose whole purpose is one of the above
  /(^|\/)packages\/(policy|secrets|quarantine-eval)\//u,
];

/**
 * The declared tier, or null when absent, or the string "conflict" when the body declares
 * more than one distinct tier. Order used to decide the verdict — strong-then-weak passed,
 * weak-then-strong blocked — so a reader scanning from the bottom saw a different claim than
 * the gate acted on.
 */
export function parseReviewTier(message) {
  const found = [...String(message ?? "").matchAll(/^\s*review-tier:\s*([a-z-]+(?:\/[a-z]+)?)\s*$/gmu)]
    .map((m) => m[1]);
  if (found.length === 0) return null;
  return new Set(found).size > 1 ? "conflict" : found[0];
}

export function needsMandatoryEvaluator(stagedFiles) {
  return stagedFiles.some((file) => MANDATORY_EVALUATOR_PATTERNS.some((pattern) => pattern.test(file)));
}

/** Returns an error string, or null when the message satisfies the contract. */
export function checkReviewTier(message, stagedFiles) {
  const subject = message.split("\n")[0] ?? "";
  const behavioural = /^(feat|fix|refactor|perf)(\(.+\))?!?:/u.test(subject);
  // A mandatory surface demands the tier WHATEVER the subject says. Gating on the type
  // alone let `chore: rewrite the outbound send policy` through with no tier at all —
  // the commit type is the author's own claim about risk, and this gate exists precisely
  // because a claim about risk is not evidence.
  const mandatory = needsMandatoryEvaluator(stagedFiles);
  if (!behavioural && !mandatory) return null;
  const tier = parseReviewTier(message);
  if (!tier) {
    return "no `review-tier:` line. contract.md §3.6 requires the tier to be recorded in the commit body.\n"
      + `  Add one of: ${TIERS.map((t) => `review-tier: ${t}`).join(" | ")}`;
  }
  if (tier === "conflict") {
    return "the body declares more than one distinct `review-tier:`. State exactly one.";
  }
  if (!TIERS.includes(tier)) {
    return `unknown review tier \`${tier}\`. Use one of: ${TIERS.join(", ")}`;
  }
  if (tier !== "independent-evaluator" && mandatory) {
    const touched = stagedFiles.filter((file) => MANDATORY_EVALUATOR_PATTERNS.some((p) => p.test(file)));
    return `this diff touches a surface where contract.md §3.6 makes a separate-instance evaluator\n`
      + `  UNCONDITIONAL, but the recorded tier is \`${tier}\`:\n`
      + touched.slice(0, 5).map((f) => `    ${f}`).join("\n")
      + `\n  Run the independent-evaluator subagent and record \`review-tier: independent-evaluator\`.`;
  }
  return null;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//u, ""));
if (invokedDirectly && process.argv[2]) {
  const message = readFileSync(process.argv[2], "utf8");
  let staged = [];
  try {
    staged = execSync("git diff --cached --name-only", { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { /* a hook without an index still checks the message shape */ }
  const problem = checkReviewTier(message, staged);
  if (problem) {
    process.stderr.write(`\n✗ REVIEW-TIER gate (guard-review-tier): ${problem}\n\n`);
    process.exit(1);
  }
}
