#!/usr/bin/env node
// Every internal `@muse/*` dependency of a composite project must also be a tsconfig
// `references` entry.
//
// This is the "stale dist" mystery class. `tsc -b` rebuilds a dependency only if it is
// REFERENCED, and each project's `include` is `src/**/*.ts` only — so a devDependency
// imported from `test/` is invisible to the compiler. The build then silently skips it,
// vitest resolves the import to a stale (or, on a fresh clone, absent) `dist/`, and the
// failure surfaces as an unrelated cross-package test error that costs a full diagnostic
// pass to trace back. `architecture.md` states the both-places rule; nothing enforced it.
//
// `apps/web` is intentionally outside the reference graph, so the gate keys on
// `composite: true` rather than on a name allowlist.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const manifests = execFileSync("git", ["ls-files", "packages/*/package.json", "apps/*/package.json"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);

// A reference is a directory path; resolve it to the package name it actually declares
// instead of inferring the name from the path.
const nameOfDir = new Map();
for (const manifest of manifests) {
  const { name } = readJson(join(ROOT, manifest));
  if (name) nameOfDir.set(dirname(manifest), name);
}

const problems = [];
for (const manifest of manifests) {
  const dir = dirname(manifest);
  const tsconfigPath = join(ROOT, dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) continue;
  const tsconfig = readJson(tsconfigPath);
  if (tsconfig.compilerOptions?.composite !== true) continue;

  const pkg = readJson(join(ROOT, manifest));
  const declared = new Set(
    [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
      .filter((dep) => dep.startsWith("@muse/")),
  );

  const referenced = new Set();
  for (const reference of tsconfig.references ?? []) {
    const referencedDir = normalize(join(dir, reference.path));
    const name = nameOfDir.get(referencedDir);
    if (!name) { problems.push(`${dir}/tsconfig.json: reference ${reference.path} resolves to no workspace package`); continue; }
    referenced.add(name);
  }

  for (const dep of [...declared].sort()) {
    if (referenced.has(dep)) continue;
    const depDir = [...nameOfDir].find(([, name]) => name === dep)?.[0];
    const hint = depDir ? relative(dir, depDir) : dep;
    problems.push(`${dir}: depends on ${dep} but tsconfig.json has no reference — add { "path": "${hint}" }`);
  }
}

if (problems.length > 0) {
  process.stdout.write(`[check-refs] ${problems.length} project-reference problem(s):\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.stdout.write(`\nA missing reference means \`tsc -b\` will not rebuild that dependency: stale dist.\n`);
  process.exit(1);
}
process.stdout.write(`[check-refs] clean — every internal dependency of a composite project is referenced.\n`);
