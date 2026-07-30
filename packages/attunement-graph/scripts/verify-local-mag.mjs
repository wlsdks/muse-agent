import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workerArtifact = new URL("../dist/mag-local-worker.mjs", import.meta.url);
await access(workerArtifact);
const { openLocalMag } = await import(new URL("../dist/local.js", import.meta.url).href);

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
