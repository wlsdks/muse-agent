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
 *     - the living ledger      (docs/goals/backlog.md)          — item advanced / recorded.
 *
 *   Escape for a genuinely trivial / measurement-only slice (mirrors guard-immutable's
 *   [core-change: human]): put `[writeback: n/a]` (or `[writeback: trivial]`) in the message.
 *
 * Other commit types (docs/test/chore/refactor) are exempt — they carry no new behavior to
 * lock. Fail-closed: exit 1 blocks the commit with a clear remedy.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

const hasTest = staged.some((f) => /\.test\.tsx?$/.test(f));
const hasGoldenCase = staged.some((f) => /(scripts|apps\/cli\/scripts)\/(verify-|eval-)[\w-]+\.mjs$/.test(f));
const advancedLedger = staged.some((f) => f === "docs/goals/backlog.md");

if (hasTest || hasGoldenCase || advancedLedger) {
  process.exit(0);
}

console.error(
  `\n✗ WRITE-BACK gate (guard-writeback): this ${type}: commit stages no compounding artifact.\n` +
    "  A non-trivial feat/fix must leave the learning behind — stage at least one of:\n" +
    "    • a *.test.ts(x) regression lock,\n" +
    "    • a verify-*.mjs / eval-*.mjs golden case, or\n" +
    "    • docs/goals/backlog.md (advance the item to Done / record the direction).\n" +
    "  Genuinely trivial or measurement-only? Add [writeback: n/a] to the commit message.\n"
);
process.exit(1);
