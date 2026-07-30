import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import * as admin from "@attunegraph/core/admin";
import { openLocalAttuneGraph } from "@attunegraph/core/local";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = realpath(join(scriptDirectory, "../../.."));
const expectedRuntimeExports = [
  "AttuneGraphAdminReadonlyError",
  "openAttuneGraphAdminReadonlyApplication"
];
const expectedDeclarationExports = [
  "AttuneGraphAdminErrorCode",
  "AttuneGraphAdminHeadResult",
  "AttuneGraphAdminReadonlyApplication",
  "AttuneGraphAdminReadonlyError",
  "AttuneGraphAdminStoreSummary",
  "AttuneGraphScope",
  "OpenAttuneGraphAdminReadonlyApplicationOptions",
  "openAttuneGraphAdminReadonlyApplication"
];

function declarationExports(source) {
  const names = [];
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/gu)) {
    for (const entry of match[1].split(",")) {
      const name = entry.trim().split(/\s+as\s+/u)[1] ?? entry.trim();
      if (name.length > 0) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

assert.deepEqual(Object.keys(admin).sort(), expectedRuntimeExports);
const adminDeclaration = await readFile(
  join(await workspaceRoot, "packages/attunegraph/dist/admin.d.ts"),
  "utf8"
);
assert.deepEqual(
  declarationExports(adminDeclaration),
  [...expectedDeclarationExports].sort()
);
for (const forbidden of [
  "Qualification",
  "Worker",
  "Snapshot",
  "Inspector",
  "Transport",
  "Clock",
  "Audit",
  "DatabaseSync"
]) {
  assert.equal(adminDeclaration.includes(forbidden), false);
}

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "attunegraph-cli-smoke-"))
);
const databasePath = join(directory, "attunegraph.sqlite");
const scope = {
  sourceId: "smoke-source",
  threadId: "smoke-thread"
};
const now = "2026-07-31T00:00:00.000Z";

try {
  const local = await openLocalAttuneGraph({ databasePath, scope });
  await local.project({
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: "cli-smoke",
      scope,
      observedAt: now,
      sourceFreshness: { state: "fresh", observedAt: now },
      assertions: [{
        schemaVersion: 1,
        id: "cli-smoke-assertion",
        subject: { kind: "artifact", id: "cli-smoke-artifact" },
        predicate: "LINKED_TO",
        object: { kind: "thread", id: scope.threadId },
        epistemicClass: "source-observed",
        sourceRefs: [{
          namespace: "attunegraph.cli-smoke",
          id: "fixture"
        }],
        recordedAt: now,
        derivation: { kind: "projection", version: "cli-smoke@1" }
      }]
    }
  });
  await local.close();

  const readonly = await admin.openAttuneGraphAdminReadonlyApplication({
    databasePath,
    sourceState: "closed-quiescent"
  });
  const directHead = await readonly.inspectHead(scope);
  assert.equal(directHead.found, true);
  assert.equal(directHead.head.scope.sourceId, scope.sourceId);
  assert.equal(directHead.head.scope.threadId, scope.threadId);
  assert.equal(directHead.head.generation, 1);
  assert.match(
    directHead.head.commitId,
    /^attunegraph-commit:attunegraph-observation:[0-9a-f]{64}$/u
  );
  assert.match(
    directHead.head.projectionFingerprint,
    /^attunegraph-observation:[0-9a-f]{64}$/u
  );
  await readonly.close();

  const cliPath = join(await workspaceRoot, "apps/cli/dist/index.js");
  const run = spawnSync(process.execPath, [
    cliPath,
    "attunegraph",
    "inspect",
    "--database",
    databasePath,
    "--source-state",
    "closed-quiescent",
    "--source-id",
    scope.sourceId,
    "--thread-id",
    scope.threadId,
    "--verify",
    "--json"
  ], {
    cwd: await workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1"
    }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout.includes(databasePath), false);
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output, {
    schemaVersion: 1,
    ok: true,
    command: "attunegraph.inspect",
    data: {
      store: {
        identity: "ATG1",
        applicationId: 1096042289,
        userVersion: 1,
        protocolVersion: 1,
        sqliteVersion: output.data.store.sqliteVersion,
        headRows: 1,
        journalRows: 1,
        maxGeneration: 1
      },
      integrity: { status: "verified" },
      head: {
        status: "found",
        generation: 1,
        commitId: directHead.head.commitId,
        projectionFingerprint: directHead.head.projectionFingerprint
      }
    }
  });
  process.stdout.write("AttuneGraph Lens built smoke passed.\n");
} finally {
  await rm(directory, { force: true, recursive: true });
}
