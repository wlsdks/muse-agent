import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  defaultInstallRunner,
  resolveInstallSpawn,
  runSourceInstall,
  sourceInstallCommands,
  supportsNode
} from "./install-source.mjs";

const dirs = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "muse-source-install-"));
  dirs.push(root);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function scripted(results = {}) {
  const calls = [];
  return {
    calls,
    run: async (call) => {
      calls.push(call);
      const key = `${call.command} ${call.args.join(" ")}`;
      if (key === "git rev-parse --abbrev-ref HEAD") return { code: 0, stderr: "", stdout: "main\n" };
      if (key === "git status --porcelain") return { code: 0, stderr: "", stdout: "" };
      return results[key] ?? { code: 0, stderr: "", stdout: "ok\n" };
    }
  };
}

test("Node support starts at 22.12", () => {
  assert.equal(supportsNode("22.11.0"), false);
  assert.equal(supportsNode("22.12.0"), true);
  assert.equal(supportsNode("24.0.0"), true);
});

test("Windows executes Corepack's pnpm.cmd shim through cmd.exe without a shell", async () => {
  const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  assert.deepEqual(resolveInstallSpawn("pnpm", ["build"], "win32", env), {
    args: ["/d", "/c", "pnpm.cmd", "build"],
    command: env.ComSpec
  });
  assert.deepEqual(resolveInstallSpawn("git", ["status"], "win32", env), {
    args: ["status"],
    command: "git"
  });

  let observed;
  const spawnImpl = (command, args, options) => {
    observed = { args, command, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };

  const result = await defaultInstallRunner({
    args: ["--dir", "apps/cli", "link", "--global"],
    command: "pnpm",
    cwd: "C:\\Muse",
    env,
    platform: "win32",
    spawnImpl
  });

  assert.equal(result.code, 0);
  assert.equal(observed.command, env.ComSpec);
  assert.deepEqual(observed.args, ["/d", "/c", "pnpm.cmd", "--dir", "apps/cli", "link", "--global"]);
  assert.equal(observed.options.shell, false);
});

test("dry run validates the checkout and prints the one install plan without mutations", async () => {
  const root = await fixture();
  const fake = scripted();
  const lines = [];
  await runSourceInstall({ dryRun: true, nodeVersion: "24.0.0", root, run: fake.run, stdout: (line) => lines.push(line) });

  assert.deepEqual(fake.calls.map((call) => `${call.command} ${call.args.join(" ")}`), [
    "git rev-parse --abbrev-ref HEAD",
    "git status --porcelain"
  ]);
  assert.match(lines.join(""), /git submodule sync --recursive/u);
  assert.match(lines.join(""), /git submodule update --init --recursive/u);
  assert.match(lines.join(""), /pnpm install --frozen-lockfile/u);
  assert.match(lines.join(""), /pnpm --dir apps\/cli link --global/u);
});

test("a successful install synchronizes recursive submodules before every pnpm step", async () => {
  const root = await fixture();
  const fake = scripted();
  const lines = [];
  await runSourceInstall({ nodeVersion: "24.0.0", root, run: fake.run, stdout: (line) => lines.push(line) });

  assert.deepEqual(fake.calls.slice(2), sourceInstallCommands(root));
  assert.deepEqual(fake.calls.slice(2, 4).map((call) => `${call.command} ${call.args.join(" ")}`), [
    "git submodule sync --recursive",
    "git submodule update --init --recursive"
  ]);
  assert.match(lines.join(""), /Update:[ ]{4}muse update/u);
  assert.match(lines.join(""), /Uninstall: pnpm --global remove @muse\/cli/u);
});

test("a recursive submodule update failure stops before pnpm", async () => {
  const root = await fixture();
  const fake = scripted({
    "git submodule update --init --recursive": { code: 1, stderr: "submodule checkout failed", stdout: "" }
  });
  await assert.rejects(
    runSourceInstall({ nodeVersion: "24.0.0", root, run: fake.run, stdout: () => undefined }),
    /submodule checkout failed/u
  );
  assert.deepEqual(fake.calls.map((call) => `${call.command} ${call.args.join(" ")}`), [
    "git rev-parse --abbrev-ref HEAD",
    "git status --porcelain",
    "git submodule sync --recursive",
    "git submodule update --init --recursive"
  ]);
});

test("a build failure stops before the global link", async () => {
  const root = await fixture();
  const fake = scripted({ "pnpm build": { code: 1, stderr: "compile failed", stdout: "" } });
  await assert.rejects(
    runSourceInstall({ nodeVersion: "24.0.0", root, run: fake.run, stdout: () => undefined }),
    /compile failed/u
  );
  assert.equal(fake.calls.some((call) => call.args.includes("link")), false);
});
