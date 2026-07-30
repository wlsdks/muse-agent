import assert from "node:assert/strict";
import test from "node:test";
import { checkReviewTier, needsMandatoryEvaluator, parseReviewTier, TIERS } from "./guard-review-tier.mjs";

const body = (tier) => `feat(x): a thing\n\nsome body\n\nreview-tier: ${tier}\n`;

test("a feat commit with a valid tier passes", () => {
  assert.equal(checkReviewTier(body("thin-review"), ["packages/x/src/a.ts"]), null);
});

// The whole point: "the evaluator passed" was a claim no script could audit.
test("a feat commit with no tier is blocked", () => {
  const problem = checkReviewTier("feat(x): a thing\n\nbody\n", ["packages/x/src/a.ts"]);
  assert.match(problem, /no `review-tier:` line/u);
});

test("fix, refactor and perf are covered too", () => {
  for (const type of ["fix", "refactor", "perf"]) {
    assert.match(checkReviewTier(`${type}: a thing\n\nbody\n`, []), /no `review-tier:`/u);
  }
});

test("docs, test and chore carry no new behavior and are exempt", () => {
  for (const type of ["docs", "test", "chore", "style", "build"]) {
    assert.equal(checkReviewTier(`${type}: a thing\n\nbody\n`, ["packages/x/src/a.ts"]), null);
  }
});

test("a breaking-change marker and a scope still parse as covered", () => {
  assert.match(checkReviewTier("feat(api)!: a thing\n\nbody\n", []), /no `review-tier:`/u);
});

test("an unknown tier is rejected with the valid set", () => {
  const problem = checkReviewTier(body("looks-fine"), []);
  assert.match(problem, /unknown review tier `looks-fine`/u);
  for (const tier of TIERS) assert.match(problem, new RegExp(tier.replace("/", "\\/"), "u"));
});

// contract.md §3.6 makes the evaluator unconditional on these surfaces. Claiming the thin
// tier there is precisely the "plausible-sounding override" HANDBOOK.md names.
test("a security-surface diff cannot claim the thin tier", () => {
  const problem = checkReviewTier(body("thin-review"), ["packages/messaging/src/channel-approval-gate.ts"]);
  assert.match(problem, /UNCONDITIONAL/u);
  assert.match(problem, /approval-gate\.ts/u);
});

test("the same diff passes when the strongest tier is recorded", () => {
  assert.equal(checkReviewTier(body("independent-evaluator"), ["packages/messaging/src/channel-approval-gate.ts"]), null);
});

// These are REAL paths in this repo, checked with git ls-files. The first version of this
// suite asserted on `packages/agent-core/src/approval-gate.ts`, which does not exist — so it
// passed while the actual approval gates sailed through with a thin review.
test("the repo's real security and persistence surfaces demand the evaluator", () => {
  for (const file of [
    "packages/messaging/src/channel-approval-gate.ts",
    "apps/api/src/chat-approval-gate.ts",
    "packages/messaging/src/outbound-effect-dispatch.ts",
    "packages/agent-core/src/local-only-policy.ts",
    "packages/agent-core/src/checkpoint.ts",
    "scripts/githooks/pre-push",
    "scripts/guard-review-tier.mjs",
    "packages/policy/src/rules.ts",
    "packages/secrets/src/store.ts",
  ]) {
    assert.equal(needsMandatoryEvaluator([file]), true, file);
  }
});

test("an ordinary source file does not demand the evaluator", () => {
  assert.equal(needsMandatoryEvaluator(["packages/recall/src/rank.ts", "apps/web/src/views/Home.tsx"]), false);
});

test("the tier line is read from its own line, not from prose mentioning it", () => {
  assert.equal(parseReviewTier("feat: x\n\nI considered review-tier: independent-evaluator here.\n"), null);
  assert.equal(parseReviewTier("feat: x\n\nreview-tier: thin-review\n"), "thin-review");
});

// The commit type is the author's own claim about risk. Gating on it alone let
// `chore: rewrite the outbound send policy` past with no tier line at all.
test("a mandatory surface demands the tier even under a chore subject", () => {
  const problem = checkReviewTier("chore: rewrite the outbound send policy\n\nbody\n", ["packages/policy/src/rules.ts"]);
  assert.match(problem, /no `review-tier:` line/u);
});

test("a chore that touches nothing risky is still exempt", () => {
  assert.equal(checkReviewTier("chore: bump a dep\n\nbody\n", ["package.json", "pnpm-lock.yaml"]), null);
});

test("every mandatory pattern matches at least one file that exists in this repo", async () => {
  const { execFileSync } = await import("node:child_process");
  const { MANDATORY_EVALUATOR_PATTERNS } = await import("./guard-review-tier.mjs");
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const pattern of MANDATORY_EVALUATOR_PATTERNS) {
    assert.ok(tracked.some((file) => pattern.test(file)), `pattern matches no tracked file: ${pattern.source}`);
  }
});

// Order used to decide the verdict: strong-then-weak passed, weak-then-strong blocked. A
// reader scanning the body from the bottom saw a different claim than the gate acted on.
test("two different tiers in one body is a conflict, whichever order", () => {
  const S = ["packages/messaging/src/channel-approval-gate.ts"];
  for (const body of [
    "feat: x\n\nreview-tier: independent-evaluator\nreview-tier: thin-review\n",
    "feat: x\n\nreview-tier: thin-review\nreview-tier: independent-evaluator\n",
  ]) {
    assert.equal(parseReviewTier(body), "conflict");
    assert.match(checkReviewTier(body, S), /more than one distinct `review-tier:`/u);
  }
});

test("the same tier repeated is not a conflict", () => {
  assert.equal(parseReviewTier("feat: x\n\nreview-tier: thin-review\nreview-tier: thin-review\n"), "thin-review");
});
