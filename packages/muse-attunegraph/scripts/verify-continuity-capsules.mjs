import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@muse/attunegraph";
const presentationSpecifier = `${packageName}/continuity-capsules`;
const expectedRuntimeExports = Object.freeze([
  "CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION",
  "CONTINUITY_CAPSULE_PRESENTATION_LIMITS",
  "ContinuityCapsulePresentationError",
  "presentContinuityCapsule",
  "verifyContinuityCapsulePresentation"
]);
const allowedTypeExports = Object.freeze([
  "ContinuityCapsulePresentationErrorCode",
  "ContinuityCapsulePresentationInput",
  "ContinuityCapsulePresentation"
]);
const forbiddenRuntimeNames = Object.freeze([
  "toolName",
  "arguments",
  "args",
  "effectId",
  "recipient",
  "approvalToken",
  "callback",
  "execute",
  "execution",
  "callable",
  "actionPayload"
]);

function fail(message) {
  throw new Error(`continuity-capsules verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactArray(actual, expected, label) {
  const sortedActual = [...actual].sort(codeUnitCompare);
  const sortedExpected = [...expected].sort(codeUnitCompare);
  assert(
    sortedActual.length === sortedExpected.length && sortedActual.every((value, index) => value === sortedExpected[index]),
    `${label} must be exactly ${JSON.stringify(sortedExpected)}, received ${JSON.stringify(sortedActual)}`
  );
}

async function expectPackagePathBlocked(subpath) {
  try {
    await import(`${packageName}/${subpath}`);
    fail(`${subpath} unexpectedly resolved through the package export map`);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    assert(code === "ERR_PACKAGE_PATH_NOT_EXPORTED", `${subpath} must fail with ERR_PACKAGE_PATH_NOT_EXPORTED, received ${String(code)}`);
  }
}

function importStatements(source) {
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']\s*;?/g;
  const statements = [];
  for (const match of source.matchAll(pattern)) {
    statements.push({ statement: match[0], specifier: match[1] });
  }
  return statements;
}

async function existingModulePath(candidate) {
  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isFile()) return candidate;
  } catch {
    // The emitted source controls the candidates below; an absent candidate is reported by the caller.
  }
  for (const extension of [".js", ".mjs"]) {
    try {
      const withExtension = `${candidate}${extension}`;
      const candidateStat = await stat(withExtension);
      if (candidateStat.isFile()) return withExtension;
    } catch {
      // Try the next emitted extension.
    }
  }
  return undefined;
}

async function inspectProductionImports(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    const source = await readFile(modulePath, "utf8");
    for (const { statement, specifier } of importStatements(source)) {
      for (const forbiddenName of forbiddenRuntimeNames) {
        assert(
          !new RegExp(`\\b${forbiddenName}\\b`).test(statement),
          `${normalize(modulePath)} has forbidden runtime import name ${forbiddenName}`
        );
      }
      if (!specifier.startsWith(".")) continue;
      const resolvedPath = await existingModulePath(resolve(dirname(modulePath), specifier));
      assert(resolvedPath !== undefined, `${normalize(modulePath)} imports missing emitted module ${specifier}`);
      assert(extname(resolvedPath) === ".js" || extname(resolvedPath) === ".mjs", `${normalize(modulePath)} imports a non-ESM production module ${specifier}`);
      pending.push(resolvedPath);
    }
  }
}

function runTypeScriptFixture(filePath) {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--noEmit",
      "--ignoreConfig",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--skipLibCheck",
      filePath
    ],
    { cwd: packageDirectory, encoding: "utf8" }
  );
}

async function verifyTypeExports() {
  const fixtureDirectory = await mkdtemp(join(packageDirectory, "scripts", ".tmp-continuity-capsule-types-"));
  try {
    const allowedFixture = join(fixtureDirectory, "allowed-types.mts");
    await writeFile(
      allowedFixture,
      `import type { ${allowedTypeExports.join(", ")} } from ${JSON.stringify(presentationSpecifier)};\n` +
        `declare const input: ContinuityCapsulePresentationInput;\n` +
        `declare const output: ContinuityCapsulePresentation;\n` +
        `declare const code: ContinuityCapsulePresentationErrorCode;\n` +
        `void [input, output, code];\n`,
      "utf8"
    );
    const allowedResult = runTypeScriptFixture(allowedFixture);
    assert(allowedResult.status === 0, `the exact allowed type imports must compile: ${allowedResult.stdout}${allowedResult.stderr}`);

    const forbiddenFixture = join(fixtureDirectory, "forbidden-types.mts");
    await writeFile(
      forbiddenFixture,
      `import type { CapsuleChangeRow, ContinuityCapsuleContext, ContinuityCapsuleManifest } from ${JSON.stringify(presentationSpecifier)};\n` +
        `void 0;\n`,
      "utf8"
    );
    const forbiddenResult = runTypeScriptFixture(forbiddenFixture);
    assert(forbiddenResult.status !== 0, "nested, context, and manifest type imports must be rejected");
    const output = `${forbiddenResult.stdout}${forbiddenResult.stderr}`;
    for (const forbiddenType of ["CapsuleChangeRow", "ContinuityCapsuleContext", "ContinuityCapsuleManifest"]) {
      assert(output.includes(forbiddenType), `forbidden type fixture did not prove ${forbiddenType} is unavailable: ${output}`);
    }
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
}

function declaredTypeOnlyExports(declaration) {
  const names = new Set();
  for (const match of declaration.matchAll(/(?:^|\n)\s*export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of declaration.matchAll(/(?:^|\n)\s*export\s+type\s*{([^}]+)}/g)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[1] ?? item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) names.add(name.trim());
    }
  }
  return [...names];
}

const presentationPath = join(packageDirectory, "dist", "continuity-capsule-presentation.js");
const declarationPath = join(packageDirectory, "dist", "continuity-capsule-presentation.d.ts");
await stat(presentationPath).catch(() => fail(`missing built presentation module at ${presentationPath}`));
await stat(declarationPath).catch(() => fail(`missing built presentation declaration at ${declarationPath}`));
const declaration = await readFile(declarationPath, "utf8");
exactArray(declaredTypeOnlyExports(declaration), allowedTypeExports, "Capsule declared type-only exports");

const presentation = await import(presentationSpecifier);
exactArray(Object.keys(presentation), expectedRuntimeExports, "Capsule runtime exports");
assert(
  Object.keys(presentation).every((name) => !/(?:Manifest|Compilation|Context)/.test(name)),
  `Capsule subpath leaked manifest/compiler/context surface: ${JSON.stringify(Object.keys(presentation).filter((name) => /(?:Manifest|Compilation|Context)/.test(name)))}`
);

await Promise.all([
  expectPackagePathBlocked("."),
  expectPackagePathBlocked("continuity-capsule-manifest"),
  expectPackagePathBlocked("continuity-capsule-context"),
  expectPackagePathBlocked("src/continuity-capsule-manifest.js")
]);
await inspectProductionImports(presentationPath);
await verifyTypeExports();

console.log("continuity-capsules built export and boundary probes passed");
