import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const reportModule = await import("./browser-computer-authority-gap-report.mjs");
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

test("projects exactly eight current browser/computer authority families without mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-browser-authority-report-"));
  const ownerStore = join(directory, "owner.json");
  await writeFile(ownerStore, '{"owner":"local"}\n');
  try {
    const env = Object.freeze({
      HOME: directory,
      MUSE_HOME: join(directory, ".muse"),
      MUSE_LOCAL_ONLY: "true",
      MUSE_NOTES_DIR: join(directory, "notes"),
      MUSE_SCHEDULER_CRON_ENABLED: "false",
      MUSE_USER_MEMORY_AUTO_EXTRACT: "false"
    });
    const beforeEnv = JSON.stringify(env);
    const beforeTree = await snapshotTree(directory);
    const first = await reportModule.createBrowserComputerAuthorityGapReport({ env });
    const second = await reportModule.createBrowserComputerAuthorityGapReport({ env });
    const afterTree = await snapshotTree(directory);

    assert.deepEqual(second, first);
    assert.deepEqual(afterTree, beforeTree);
    assert.equal(JSON.stringify(env), beforeEnv);
    assert.deepEqual(
      first.actions.map((row) => row.action),
      ["inspect", "fill", "submit", "upload", "download", "clipboard", "screen", "process"]
    );
    assert.deepEqual(
      Object.fromEntries(first.actions.map((row) => [row.action, row.authorityClass])),
      {
        clipboard: "local-write",
        download: "unmapped",
        fill: "unmapped",
        inspect: "unmapped",
        process: "process",
        screen: "read",
        submit: "unmapped",
        upload: "unmapped"
      }
    );
    for (const row of first.actions) {
      assert.ok(row.tools.length > 0);
      assert.equal(new Set(row.tools.map((tool) => tool.name)).size, row.tools.length);
      assert.ok(
        row.authorityClass === "unmapped"
          || row.tools.every(
            (tool) =>
              tool.cataloguedInPermissionReport
              && tool.authorityClass === row.authorityClass
          )
      );
    }
    assert.equal(
      first.actions.find((row) => row.action === "inspect").tools[0]
        .cataloguedInPermissionReport,
      false
    );
    assert.deepEqual(
      first.actions
        .find((row) => row.action === "submit")
        .tools.find((tool) => tool.name === "web_action"),
      {
        authorityClass: "network",
        cataloguedInPermissionReport: true,
        name: "web_action"
      }
    );
    assert.equal(
      first.actions.find((row) => row.action === "process").tools.length,
      9
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("report command is stdout-only deterministic JSON", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/browser-computer-authority-gap-report.mjs"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    await reportModule.createBrowserComputerAuthorityGapReport()
  );
});
