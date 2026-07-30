import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = new URL("../", import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);
const distRoot = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(await readFile(
  new URL("../local-mag-runtime-manifest.json", import.meta.url),
  "utf8"
));
assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(
  [...manifest.sourceModules].sort(),
  [
    "mag-local-profile.mjs",
    "mag-local-projection.mjs",
    "mag-local-protocol.mjs",
    "mag-local-sqlite.mjs",
    "mag-local-worker.mjs"
  ]
);

const sourceRuntimeModules = (await readdir(sourceRoot))
  .filter((name) => /^mag-local-.*\.mjs$/u.test(name))
  .sort();
assert.deepEqual(sourceRuntimeModules, [...manifest.sourceModules].sort());

const distEntries = await readdir(distRoot);
const emittedRuntimeModules = distEntries
  .filter((name) => /^mag-local-.*\.mjs$/u.test(name))
  .sort();
const emittedDeclarations = distEntries
  .filter((name) => /^mag-local-.*\.d\.mts$/u.test(name))
  .sort();
assert.deepEqual(emittedRuntimeModules, sourceRuntimeModules);
assert.deepEqual(
  emittedDeclarations,
  sourceRuntimeModules.map((name) => name.replace(/\.mjs$/u, ".d.mts"))
);

const sourceBodies = new Map(await Promise.all(sourceRuntimeModules.map(async (name) => [
  name,
  await readFile(new URL(name, sourceRoot), "utf8")
])));
const emittedBodies = new Map(await Promise.all(emittedRuntimeModules.map(async (name) => [
  name,
  await readFile(new URL(name, distRoot), "utf8")
])));
for (const [name, body] of sourceBodies) {
  assert.doesNotMatch(
    body,
    /@ts-(?:nocheck|ignore)|eslint-disable(?:-next-line)?/u,
    `${name} contains a forbidden type or lint suppression`
  );
}
assert.deepEqual(
  [...sourceBodies].filter(([, body]) => body.includes('"node:sqlite"')).map(([name]) => name),
  [manifest.sqliteExecutionModule]
);
assert.deepEqual(
  [...emittedBodies].filter(([, body]) => body.includes('"node:sqlite"')).map(([name]) => name),
  [manifest.sqliteExecutionModule]
);
assert.deepEqual(
  [...sourceBodies].filter(([, body]) =>
    body.includes(`"./${manifest.sqliteExecutionModule}"`)
  ).map(([name]) => name),
  [manifest.workerEntryModule]
);
assert.deepEqual(
  [...emittedBodies].filter(([, body]) =>
    body.includes(`"./${manifest.sqliteExecutionModule}"`)
  ).map(([name]) => name),
  [manifest.workerEntryModule]
);
for (const declaration of emittedDeclarations) {
  const body = await readFile(new URL(declaration, distRoot), "utf8");
  assert.doesNotMatch(
    body,
    /\bany\b/u,
    `${declaration} exposes an untyped runtime seam`
  );
}

const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
assert.deepEqual(packageJson.exports["./local"], {
  types: "./dist/local.d.ts",
  import: "./dist/local.js"
});
for (const target of Object.values(packageJson.exports)) {
  assert.equal(
    JSON.stringify(target).includes("mag-local-"),
    false,
    "internal local worker modules must not be package exports"
  );
}

const { openLocalMag } = await import(new URL("../dist/local.js", import.meta.url).href);
const localRuntime = await import(new URL("../dist/local.js", import.meta.url).href);
assert.deepEqual(Object.keys(localRuntime).sort(), manifest.publicLocalRuntimeExports);
const localDeclaration = await readFile(new URL("../dist/local.d.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  localDeclaration,
  /^export\s+(?:type\s+)?(?:\*|\{)/gmu,
  "local declaration must not hide public names behind export-star or export-list forms"
);
const declaredLocalExports = [...localDeclaration.matchAll(
  /^export (?:declare )?(?:interface|function|class|const|type) ([A-Za-z0-9_]+)/gmu
)].map((match) => match[1]).sort();
assert.deepEqual(declaredLocalExports, [...manifest.publicLocalTypeExports].sort());
process.stdout.write("local MAG runtime manifest and public-surface verification passed\n");

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "muse-mag-built-"))
);
const databasePath = join(directory, "mag.sqlite");
const scope = { sourceId: "built-smoke-source", threadId: "built-smoke-thread" };
const now = "2026-07-30T00:00:00.000Z";
const command = {
  operator: "canonical-projection@1",
  observation: {
    schemaVersion: 1,
    observationKey: "built-smoke",
    scope,
    observedAt: now,
    sourceFreshness: { state: "fresh", observedAt: now },
    assertions: [{
      schemaVersion: 1,
      id: "built-smoke-assertion",
      subject: { id: "built-smoke-artifact", kind: "artifact" },
      predicate: "LINKED_TO",
      object: { id: scope.threadId, kind: "thread" },
      epistemicClass: "source-observed",
      sourceRefs: [{ id: "built-smoke-source-ref", namespace: "muse.built-smoke" }],
      recordedAt: now,
      derivation: { kind: "projection", version: "built-smoke@1" }
    }]
  }
};

try {
  const first = await openLocalMag({ databasePath, scope });
  const snapshot = await first.project(command);
  const result = await first.execute({
    operator: "working-graph@1",
    seed: { id: scope.threadId, kind: "thread" },
    now,
    maxEstimatedTokens: 256
  });
  await first.close();

  const reopened = await openLocalMag({ databasePath, scope });
  const replay = await reopened.project(command);
  const recovered = await reopened.execute({
    operator: "working-graph@1",
    seed: { id: scope.threadId, kind: "thread" },
    now,
    maxEstimatedTokens: 256
  });
  await reopened.close();

  assert.deepEqual(replay, snapshot);
  assert.deepEqual(recovered, result);
  process.stdout.write("local MAG built-output restart smoke passed\n");
} finally {
  await rm(directory, { force: true, recursive: true });
}

if (process.env.MUSE_MAG_INPUT_TYPE_CHILD !== "1") {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(import.meta.url)})`
    ],
    {
      encoding: "utf8",
      env: { ...process.env, MUSE_MAG_INPUT_TYPE_CHILD: "1" },
      timeout: 15_000
    }
  );
  assert.equal(
    child.status,
    0,
    `local MAG --input-type=module smoke failed: ${child.stderr || child.stdout}`
  );
  process.stdout.write("local MAG inherited-execArgv isolation smoke passed\n");
}
