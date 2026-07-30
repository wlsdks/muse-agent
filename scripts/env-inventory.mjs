#!/usr/bin/env node
// The Muse + AttuneGraph environment-variable inventory + drift guard.
//
// Muse's configuration surface is hundreds of MUSE_* variables, while the
// standalone-neutral AttuneGraph core owns ATTUNEGRAPH_* variables. Both are
// read across the workspace without a central registry. This script makes the
// complete product surface ENUMERATED and GUARDED: it extracts every supported
// namespace referenced in product source (packages/ + apps/, tests excluded),
// renders docs/setup/ENV.md from that ground truth, and in --check mode fails
// when the doc no longer matches the source.
//
//   node scripts/env-inventory.mjs --write   # regenerate docs/setup/ENV.md
//   node scripts/env-inventory.mjs --check   # exit 1 when docs/setup/ENV.md is stale
//
// Zero deps. Pure helpers exported for scripts/env-inventory.test.mjs.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const DOC = join(ROOT, "docs/setup/ENV.md");
const SOURCE_ROOTS = ["packages", "apps"];

const ENV_RE = /\b(?:ATTUNEGRAPH|MUSE)_[A-Z0-9_]+\b/g;

/** Every distinct product-owned environment token in one source string. */
export function extractEnvVars(source) {
  return [...new Set(source.match(ENV_RE) ?? [])];
}

/** The workspace name a source path belongs to, e.g. packages/recall → @scope-free "packages/recall". */
export function workspaceOf(relPath) {
  const parts = relPath.split(sep);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? relPath;
}

/**
 * Walk the product source and build { varName → Set<workspace> }.
 * Tests, dist, and node_modules are excluded — this inventories the vars the
 * PRODUCT reads, not what a test fixture happens to mention.
 */
export function collectInventory(root = ROOT) {
  const inventory = new Map();
  const record = (name, ws) => {
    if (!inventory.has(name)) inventory.set(name, new Set());
    inventory.get(name).add(ws);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mts|mjs)$/.test(entry.name) || /\.test\.(ts|tsx|mts|mjs)$/.test(entry.name)) continue;
      const rel = relative(root, full);
      const ws = workspaceOf(rel);
      for (const name of extractEnvVars(readFileSync(full, "utf8"))) record(name, ws);
    }
  };
  for (const sourceRoot of SOURCE_ROOTS) {
    const p = join(root, sourceRoot);
    if (existsSync(p)) walk(p);
  }
  return inventory;
}

/** Render the inventory as a stable, byte-deterministic markdown doc. */
export function renderEnvDoc(inventory) {
  const names = [...inventory.keys()].sort();
  const lines = [
    "# Muse and AttuneGraph environment variables — generated inventory",
    "",
    "**Generated file — do not edit by hand.** Regenerate with `pnpm docs:env`;",
    "`pnpm check:env` (CI / self-eval) fails when this file no longer matches the",
    "source. Every `MUSE_*` or `ATTUNEGRAPH_*` referenced in product source",
    "(`packages/`, `apps/`; tests excluded) is listed with the workspaces that read it. Descriptions and",
    "value contracts are curated incrementally in code (`.claude/rules/` /",
    "per-module docs); this inventory is the discoverability + drift floor.",
    "",
    `Total: **${names.length}** variables.`,
    "",
    "| Variable | Read by |",
    "| --- | --- |",
    ...names.map((n) => `| \`${n}\` | ${[...inventory.get(n)].sort().join(", ")} |`),
    ""
  ];
  return lines.join("\n");
}

const mode = process.argv[2];
if (mode === "--write" || mode === "--check") {
  const rendered = renderEnvDoc(collectInventory());
  if (mode === "--write") {
    writeFileSync(DOC, rendered);
    console.log(`✓ docs/setup/ENV.md written (${rendered.split("\n").length} lines).`);
    process.exit(0);
  }
  const current = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
  if (current === rendered) {
    console.log("✓ docs/setup/ENV.md matches the source-of-truth inventory.");
    process.exit(0);
  }
  console.error("✗ docs/setup/ENV.md is stale — the product environment surface changed without the inventory following.");
  console.error("  Regenerate with: pnpm docs:env");
  process.exit(1);
}
