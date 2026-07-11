#!/usr/bin/env node
/**
 * Secret-persistence-guard coverage drift lint.
 *
 * This is the SAME bug class shipped five times in a row (identity notes,
 * false-action notes, secret-notes, secret-registry, calendar) before
 * this check existed: a persistence tool (`risk: "write"`, writes a
 * free-text field like `title`/`notes`/`content` straight to a store) that
 * never calls `guardSecretPersistence` / `assertNoSecretInPersistedFields`
 * at all. A unit test proves the tools THIS SESSION KNOWS ABOUT are
 * guarded; this script instead greps every domain-tools source file so a
 * SIXTH surface can't silently reintroduce the same hole — a new
 * `risk: "write"` tool that reads `notes`/`content`/etc. and forgets the
 * guard call fails this gate the moment it's written, not after an
 * adversarial review finds it.
 *
 * Heuristic, not a real parser (see splitIntoToolSegments in
 * scripts/lib/secret-guard-coverage.mjs for the exact segmentation rule).
 * A tool that's a legitimate exception (its free-text field is governed by
 * a DIFFERENT mitigation — e.g. messaging `send`'s outbound-safety
 * draft-first/approval-gate, not local unencrypted persistence) is listed
 * in EXEMPT below with the reason. Do not add an entry there to silence a
 * real gap — fix the tool instead.
 *
 * Runnable as `pnpm check:secret-guard-coverage`. Zero deps.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { findViolations } from "./lib/secret-guard-coverage.mjs";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "packages/domain-tools/src");

const EXEMPT = new Map([
  [
    "packages/domain-tools/src/loopback-messaging.ts:send",
    "outbound network send to a THIRD PARTY — governed by outbound-safety.md's " +
    "draft-first + approval-gate contract (the user confirms the exact text " +
    "before it leaves), not local unencrypted-store persistence. Its incidental " +
    "action-log copy already runs redactSecrets and is encrypted-file-backed."
  ]
]);

function listSourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!/\.ts$/u.test(entry.name)) continue;
    if (/\.test\.ts$/u.test(entry.name)) continue;
    files.push(join(dir, entry.name));
  }
  return files;
}

const allViolations = [];
const staleExemptEntries = new Set(EXEMPT.keys());

for (const file of listSourceFiles(SRC_DIR)) {
  const relPath = relative(ROOT, file).split("\\").join("/");
  const content = readFileSync(file, "utf8");
  for (const violation of findViolations(relPath, content)) {
    const key = `${violation.file}:${violation.tool}`;
    if (EXEMPT.has(key)) {
      staleExemptEntries.delete(key);
      continue;
    }
    allViolations.push(violation);
  }
}

if (staleExemptEntries.size > 0) {
  console.log(`[check-secret-guard-coverage] ${staleExemptEntries.size} stale EXEMPT entr(y/ies) — the tool no longer trips the check, consider removing it:`);
  for (const key of staleExemptEntries) console.log(`  ${key}`);
}

if (allViolations.length > 0) {
  console.error(`[check-secret-guard-coverage] ${allViolations.length} unguarded persistence tool(s):`);
  for (const v of allViolations) {
    console.error(`  ${v.file} — tool "${v.tool}" is risk:"write", reads a free-text field, and never calls guardSecretPersistence/assertNoSecretInPersistedFields`);
  }
  console.error(
    "\nEvery write tool that persists user-authored free text to a store must call " +
    "assertNoSecretInPersistedFields({...}) (or guardSecretPersistence(text)) BEFORE the " +
    "write, and return { blocked: true, error: guard.notice, kinds: guard.kinds } when unsafe. " +
    "If this tool's free-text field is genuinely governed by a different mitigation, add it " +
    "to EXEMPT in this script with a one-line reason — don't add one to silence a real gap."
  );
  process.exit(1);
}
console.log("[check-secret-guard-coverage] clean — every risk:\"write\" domain-tools persistence tool that reads a free-text field calls the secret guard.");
