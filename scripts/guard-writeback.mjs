#!/usr/bin/env node
/**
 * guard-writeback — make the improve-muse WRITE-BACK completion gate REAL, not prose.
 *
 * Invoked as a commit-msg hook. The dev loop's whole "flywheel not treadmill" promise rests
 * on every non-trivial slice leaving the learning behind (a golden case / test, and the
 * backlog ledger advanced). That was aspirational text an agent could skip under pressure —
 * the exact step every methodology says everyone skips. This checks it deterministically:
 *
 *   A `feat:` or `fix:` commit MUST stage at least one of:
 *     - a test file            (*.test.ts / *.test.tsx)         — a regression lock, OR
 *     - a golden-case battery  (scripts|apps/cli/scripts/verify-*.mjs or eval-*.mjs), OR
 *     - the living ledger      (internal/goals/backlog.md)          — item advanced / recorded.
 *
 *   Escape for a genuinely trivial / measurement-only slice (mirrors guard-immutable's
 *   [core-change: human]): put `[writeback: n/a]` (or `[writeback: trivial]`) in the message.
 *
 * Other commit types (docs/test/chore/refactor) are exempt — they carry no new behavior to
 * lock. Fail-closed: exit 1 blocks the commit with a clear remedy.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Does the staged file list contain a compounding artifact (the WRITE-BACK
 * proof)? Pure + exported so the recognition rules are unit-tested:
 *  - a regression-lock test — `*.test.ts(x)` OR the `scripts/*` node:test
 *    convention `*.test.mjs` (run by `pnpm self-eval:test`),
 *  - a golden-case battery — `(scripts|apps/cli/scripts)/(verify-|eval-)*.mjs`,
 *  - the living ledger — `internal/goals/backlog.md` advanced.
 */
export function stagesCompoundingArtifact(stagedFiles) {
  const hasTest = stagedFiles.some((f) => /\.test\.(tsx?|mjs)$/.test(f));
  const hasGoldenCase = stagedFiles.some((f) => /(scripts|apps\/cli\/scripts)\/(verify-|eval-)[\w-]+\.mjs$/.test(f));
  const advancedLedger = stagedFiles.some((f) => f === "internal/goals/backlog.md");
  return hasTest || hasGoldenCase || advancedLedger;
}

function main() {
  const msgPath = process.argv[2];
  if (!msgPath) {
    // Not invoked as a commit-msg hook — nothing to check.
    process.exit(0);
  }

  const message = readFileSync(msgPath, "utf8");
  const subject = message.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";

  // Only feat/fix carry new behavior that must compound. Conventional Commit type at the start.
  const type = /^(\w+)(\([^)]*\))?!?:/.exec(subject)?.[1];
  if (type !== "feat" && type !== "fix") {
    process.exit(0);
  }

  // Greppable escape for trivial / measurement-only slices.
  if (/\[writeback:\s*(n\/?a|trivial|skip)\]/i.test(message)) {
    process.exit(0);
  }

  let staged = [];
  try {
    staged = execSync("git diff --cached --name-only", { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // Can't read the index — don't block on tooling failure (fail-open ONLY on infra error).
    process.exit(0);
  }

  if (stagesCompoundingArtifact(staged)) {
    process.exit(0);
  }

  console.error(
    `\n✗ WRITE-BACK gate (guard-writeback): this ${type}: commit stages no compounding artifact.\n` +
      "  A non-trivial feat/fix must leave the learning behind — stage at least one of:\n" +
      "    • a *.test.ts(x) / scripts/*.test.mjs regression lock,\n" +
      "    • a verify-*.mjs / eval-*.mjs golden case, or\n" +
      "    • internal/goals/backlog.md (advance the item to Done / record the direction).\n" +
      "  Genuinely trivial or measurement-only? Add [writeback: n/a] to the commit message.\n"
  );
  process.exit(1);
}

// Only run as a hook — importing for the unit test must NOT execute (would call process.exit).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
