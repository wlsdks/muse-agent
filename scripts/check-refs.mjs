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
// `composite: true` rather than on a name allowlist. Probing confirmed that setting
// `composite: false` exits the gate — accepted, because doing so also removes the project
// from the `tsc -b` graph entirely, so the evasion costs more than the check it avoids.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const manifests = ["packages", "apps"].flatMap((workspaceDirectory) => {
  const directory = join(ROOT, workspaceDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(workspaceDirectory, entry.name, "package.json"))
    .filter((manifest) => existsSync(join(ROOT, manifest)));
});

// A reference is a directory path; resolve it to the package name it actually declares
// instead of inferring the name from the path.
const nameOfDir = new Map();
for (const manifest of manifests) {
  const { name } = readJson(join(ROOT, manifest));
  if (name) nameOfDir.set(dirname(manifest), name);
}

// A reference graph must stay acyclic (architecture.md), and that outranks the
// both-places rule. `packages/mcp` devDepends on `@muse/domain-tools`, which depends back
// on mcp, so demanding that reference makes `tsc -b` fail with TS6202. The cycle is a
// deterministic fact of the manifests, so the gate proves it rather than keeping a
// hand-maintained exception list — but it reports the count, because the stale-dist risk
// for such a pair is real and must not become invisible.
const dependsOn = new Map();
for (const manifest of manifests) {
  const pkg = readJson(join(ROOT, manifest));
  dependsOn.set(dirname(manifest), new Set(
    [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
      .filter((dep) => dep.startsWith("@muse/")),
  ));
}
const dirOfName = new Map([...nameOfDir].map(([dir, name]) => [name, dir]));
const reaches = (fromDir, targetName, seen = new Set()) => {
  if (!fromDir || seen.has(fromDir)) return false;
  seen.add(fromDir);
  const edges = dependsOn.get(fromDir) ?? new Set();
  if (edges.has(targetName)) return true;
  return [...edges].some((dep) => reaches(dirOfName.get(dep), targetName, seen));
};

let cycleExempt = 0;
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
    if (reaches(dirOfName.get(dep), nameOfDir.get(dir))) { cycleExempt += 1; continue; }
    const hint = dirOfName.has(dep) ? relative(dir, dirOfName.get(dep)) : dep;
    problems.push(`${dir}: depends on ${dep} but tsconfig.json has no reference — add { "path": "${hint}" }`);
  }
}

if (problems.length > 0) {
  process.stdout.write(`[check-refs] ${problems.length} project-reference problem(s):\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.stdout.write(`\nA missing reference means \`tsc -b\` will not rebuild that dependency: stale dist.\n`);
  process.exit(1);
}
process.stdout.write(`[check-refs] clean — every internal dependency of a composite project is referenced (${cycleExempt} exempt: referencing them would cycle).\n`);
