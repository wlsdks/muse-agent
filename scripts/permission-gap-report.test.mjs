import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const reportModule = await import("./permission-gap-report.mjs");
const { ACTUATOR_PERMISSION_MATRIX } = await import("../apps/cli/src/actuator-tools.ts");
const { createApiServerOptions } = await import("../packages/autoconfigure/src/index.ts");
const root = fileURLToPath(new URL("..", import.meta.url));

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshotTree(directory, current = directory) {
  const rows = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const metadata = await stat(path);
    const relative = path.slice(directory.length);
    if (metadata.isDirectory()) {
      rows.push(`dir:${relative}`);
      rows.push(...await snapshotTree(directory, path));
    } else {
      rows.push(`file:${relative}:${digest(await readFile(path))}`);
    }
  }
  return rows;
}

test("permission gap report covers each public surface deterministically without mutating an owner store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-permission-gap-report-"));
  const ownerStore = join(directory, "channel-owners.json");
  const initial = Buffer.from('{"version":1,"owners":[]}\n');
  await writeFile(ownerStore, initial);

  try {
    const env = Object.freeze({
      HOME: directory,
      MUSE_CHANNEL_OWNERS_FILE: ownerStore,
      MUSE_HOME: join(directory, ".muse"),
      MUSE_LOCAL_ONLY: "true",
      MUSE_NOTES_DIR: join(directory, "notes"),
      MUSE_SCHEDULER_CRON_ENABLED: "false",
      MUSE_USER_MEMORY_AUTO_EXTRACT: "false"
    });
    const beforeEnv = JSON.stringify(env);
    const before = digest(await readFile(ownerStore));
    const beforeTree = await snapshotTree(directory);
    const first = await reportModule.createPermissionGapReport({ env });
    const second = await reportModule.createPermissionGapReport({ env });
    const after = digest(await readFile(ownerStore));
    const afterTree = await snapshotTree(directory);

    assert.equal(after, before, "generating the report must not change the disposable owner store");
    assert.deepEqual(afterTree, beforeTree, "generating the report must not create or change any disposable HOME artifact");
    assert.equal(JSON.stringify(env), beforeEnv, "generating the report must not mutate the caller's environment");
    assert.deepEqual(second, first, "the report must be deterministic");

    const seen = new Set();
    for (const row of first.rows) {
      assert.ok(["read", "local-write", "process", "network", "external-send", "unmapped"].includes(row.authorityClass));
      assert.ok(
        row.authorityClass === "unmapped"
          || row.surface === "tool"
          || (row.surface === "cli" && row.name === "email send" && row.authorityClass === "external-send"),
        "only existing actuator classifications and the exact email-send closure may be mapped"
      );
      const key = `${row.surface}\u0000${row.name}`;
      assert.ok(!seen.has(key), `duplicate report row: ${key}`);
      seen.add(key);
    }

    for (const surface of ["tool", "cli", "api", "mcp"]) {
      assert.ok(first.rows.some((row) => row.surface === surface), `missing ${surface} rows`);
    }

    const toolRows = first.rows.filter((row) => row.surface === "tool");
    const expectedToolNames = new Set([
      ...createApiServerOptions({
        env: { ...env, MUSE_NOTES_DIR: directory },
        localOnlyOverride: true
      }).toolCatalogProvider().map((tool) => tool.name),
      ...Object.keys(ACTUATOR_PERMISSION_MATRIX)
    ]);
    assert.deepEqual(new Set(toolRows.map((row) => row.name)), expectedToolNames);
    assert.ok(toolRows.some((row) => row.authorityClass === "unmapped"), "general public tools must be explicit gaps");
    for (const [name, authorityClass] of Object.entries(ACTUATOR_PERMISSION_MATRIX)) {
      assert.equal(toolRows.find((row) => row.name === name)?.authorityClass, authorityClass);
    }
    assert.deepEqual(
      first.rows.filter((row) => row.surface !== "tool" && row.authorityClass !== "unmapped"),
      [{ authorityClass: "external-send", name: "email send", surface: "cli" }]
    );
    assert.ok(first.rows.some((row) => row.surface === "cli" && row.name === "approval approve"));
    assert.ok(first.rows.some((row) => row.surface === "cli" && row.name === "tasks list"));
    assert.ok(first.rows.some((row) => row.surface === "api" && row.name === "GET /api/tasks"));
    assert.ok(first.rows.some((row) => row.surface === "api" && row.name === "POST /api/tasks"));
    assert.ok(first.rows.some((row) => row.surface === "tool" && row.name === "muse.tasks.list"));
    assert.equal(reportModule.classifyPermissionGapAuthority("tool", "future_actuator"), "unmapped");
    assert.equal(reportModule.classifyPermissionGapAuthority("cli", "email send"), "external-send");
    assert.equal(reportModule.classifyPermissionGapAuthority("cli", "email reply"), "unmapped");
    assert.equal(reportModule.classifyPermissionGapAuthority("cli", "Email send"), "unmapped");
    assert.equal(reportModule.classifyPermissionGapAuthority("mcp", "email send"), "unmapped");

    const sorted = [...first.rows].sort((left, right) =>
      ["tool", "cli", "api", "mcp"].indexOf(left.surface) - ["tool", "cli", "api", "mcp"].indexOf(right.surface)
      || left.name.localeCompare(right.name)
    );
    assert.deepEqual(first.rows, sorted, "rows must have stable surface/name ordering");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("report script is stdout-only JSON", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/permission-gap-report.mjs"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), await reportModule.createPermissionGapReport());
});

test("task-list quarantine authority is adapter-neutral across CLI, API, Web, and MCP", async () => {
  const results = reportModule.TASK_LIST_AUTHORITY_PARITY.adapters.map((adapter) =>
    reportModule.resolveAuthorityParity({
      ...adapter,
      effect: reportModule.TASK_LIST_AUTHORITY_PARITY.effect,
      target: reportModule.TASK_LIST_AUTHORITY_PARITY.target
    })
  );
  assert.deepEqual(
    results,
    Array.from({ length: 4 }, () => ({ approval: "not-required", authorityClass: "local-write" }))
  );
  assert.equal(new Set(results.map((result) => JSON.stringify(result))).size, 1);

  for (const input of [
    { effect: "list-with-corrupt-store-quarantine", name: "tasks list", surface: "cli", target: "other-task-store" },
    { effect: "list", name: "tasks list", surface: "cli", target: "owner-task-store" },
    { effect: "create", name: "tasks list", surface: "cli", target: "owner-task-store" },
    { effect: "list-with-corrupt-store-quarantine", name: "tasks add", surface: "cli", target: "owner-task-store" },
    { effect: "list-with-corrupt-store-quarantine", name: "GET /api/tasks", surface: "web", target: "owner-task-store" },
    { effect: "list-with-corrupt-store-quarantine", name: "muse.tasks.list", surface: "tool", target: "owner-task-store" }
  ]) {
    assert.deepEqual(
      reportModule.resolveAuthorityParity(input),
      { approval: "unverified", authorityClass: "unmapped" }
    );
  }
});
