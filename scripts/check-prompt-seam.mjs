#!/usr/bin/env node
/**
 * Prompt-seam drift lint (docs/strategy/prompt-architecture.md §5, guardrail
 * 4): every surface's identity/system-prompt text is meant to funnel through
 * packages/prompts/src/identity-core.ts + compose.ts (composeSurfacePrompt).
 * A hardcoded "You are Muse" / "너는 뮤즈" string, or a direct
 * `buildSystemPrompt(` call, anywhere else in `src/` re-opens the divergent
 * per-surface identity strings the seam exists to close.
 *
 * Scoped to `src/` production files, skipping `*.test.ts(x)` — some
 * workspaces (apps/cli, packages/recall) colocate tests inside `src/`
 * rather than a separate `test/` dir, and several tests use "You are Muse."
 * as a generic placeholder string to exercise unrelated logic (token-budget
 * math, message plumbing) — that is not a production identity leak and
 * would just be whitelist noise for this guard's actual purpose.
 *
 * LEGACY_* below is the Phase 2/3 shrink target from the architecture doc's
 * migration plan — remove an entry the moment its file is wired through
 * composeSurfacePrompt. A NEW offender not on either list fails the gate.
 *
 * Runnable as `pnpm check:prompt-seam`. Zero deps.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["packages", "apps"];

// Phase 2/3 (docs/strategy/prompt-architecture.md migration plan) — not yet
// wired through composeSurfacePrompt. Shrink this list as each file
// migrates; do NOT add a freshly-written file here instead of migrating it.
const LEGACY_IDENTITY_STRING_FILES = new Set([
  "apps/api/src/identity-tagline.ts",
  "apps/cli/src/chat-reflection.ts",
  "apps/cli/src/commands-brief.ts",
  "apps/cli/src/commands-read.ts",
  "apps/cli/src/companion-line.ts",
  "packages/recall/src/pipeline.ts"
]);

const LEGACY_BUILD_SYSTEM_PROMPT_FILES = new Set([
  "packages/recall/src/pipeline.ts"
]);

const IDENTITY_STRING_PATTERNS = [/You are Muse\b/u, /너는 뮤즈/u];
const BUILD_SYSTEM_PROMPT_PATTERN = /\bbuildSystemPrompt\s*\(/u;
const EXEMPT_FILES = new Set([
  "packages/prompts/src/identity-core.ts",
  "packages/prompts/src/compose.ts"
]);

function* walkSrc(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      yield* walkSrc(full);
    } else if (/\.(ts|tsx)$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) {
      yield full;
    }
  }
}

const violations = [];
const staleWhitelistEntries = [];

for (const root of ROOTS) {
  let workspaces;
  try {
    workspaces = readdirSync(join(ROOT, root));
  } catch {
    continue;
  }
  for (const workspace of workspaces) {
    for (const file of walkSrc(join(ROOT, root, workspace, "src"))) {
      const relPath = relative(ROOT, file).split("\\").join("/");
      const isPromptsPackage = relPath.startsWith("packages/prompts/src/");
      const isExempt = EXEMPT_FILES.has(relPath);
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");

      if (!isExempt) {
        lines.forEach((line, index) => {
          if (!IDENTITY_STRING_PATTERNS.some((re) => re.test(line))) return;
          if (LEGACY_IDENTITY_STRING_FILES.has(relPath)) return;
          violations.push({
            file: relPath,
            line: index + 1,
            reason: "hardcoded identity string — route through @muse/prompts composeSurfacePrompt/identity-core instead",
            text: line.trim().slice(0, 140)
          });
        });
      }

      if (!isPromptsPackage) {
        lines.forEach((line, index) => {
          if (!BUILD_SYSTEM_PROMPT_PATTERN.test(line)) return;
          if (LEGACY_BUILD_SYSTEM_PROMPT_FILES.has(relPath)) return;
          violations.push({
            file: relPath,
            line: index + 1,
            reason: "direct buildSystemPrompt( call — use composeSurfacePrompt() from @muse/prompts instead",
            text: line.trim().slice(0, 140)
          });
        });
      }
    }
  }
}

// A whitelist entry whose file no longer trips its pattern is drift the
// other way: the shrinking-TODO list didn't shrink when the code did.
// Reported (not failed) so cleanup doesn't need to happen in lockstep with
// this run, but the log makes the stale entry visible.
function stillMatches(relPath, patterns) {
  const abs = join(ROOT, relPath);
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  return content.split("\n").some((line) => patterns.some((re) => re.test(line)));
}
for (const relPath of LEGACY_IDENTITY_STRING_FILES) {
  if (!stillMatches(relPath, IDENTITY_STRING_PATTERNS)) {
    staleWhitelistEntries.push(`${relPath} (identity-string whitelist entry no longer matches — migrated? remove it)`);
  }
}
for (const relPath of LEGACY_BUILD_SYSTEM_PROMPT_FILES) {
  if (!stillMatches(relPath, [BUILD_SYSTEM_PROMPT_PATTERN])) {
    staleWhitelistEntries.push(`${relPath} (buildSystemPrompt( whitelist entry no longer matches — migrated? remove it)`);
  }
}

if (staleWhitelistEntries.length > 0) {
  console.log(`[check-prompt-seam] ${staleWhitelistEntries.length} stale whitelist entr(y/ies) — consider shrinking the TODO list:`);
  for (const entry of staleWhitelistEntries) console.log(`  ${entry}`);
}

if (violations.length > 0) {
  console.error(`[check-prompt-seam] ${violations.length} prompt-seam drift violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.reason}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    "\nEvery surface's identity/role text goes through composeSurfacePrompt() / "
    + "identity-core.ts (docs/strategy/prompt-architecture.md). A new hardcoded "
    + "string or direct buildSystemPrompt( call outside packages/prompts is not "
    + "allowed — either migrate the call site or (only for an already-tracked "
    + "Phase 2/3 file) add it to the LEGACY_* list in this script."
  );
  process.exit(1);
}
console.log("[check-prompt-seam] clean — no new hardcoded identity strings or direct buildSystemPrompt( calls outside the seam.");
