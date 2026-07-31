#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIN_NODE = { major: 22, minor: 12 };
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export function supportsNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

export function sourceInstallCommands(root) {
  return [
    { args: ["submodule", "sync", "--recursive"], command: "git", cwd: root },
    { args: ["submodule", "update", "--init", "--recursive"], command: "git", cwd: root },
    { args: ["--version"], command: "pnpm", cwd: root },
    { args: ["bin", "--global"], command: "pnpm", cwd: root },
    { args: ["install", "--frozen-lockfile"], command: "pnpm", cwd: root },
    { args: ["build"], command: "pnpm", cwd: root },
    { args: ["--dir", "apps/cli", "link", "--global"], command: "pnpm", cwd: root },
    { args: [join(root, "apps", "cli", "dist", "index.js"), "--version"], command: process.execPath, cwd: root }
  ];
}

function sourceInstallLabel(call) {
  if (call.command === "pnpm" && call.args.join(" ") === "bin --global") {
    return "pnpm global-bin check (run `pnpm setup`, restart the shell, and retry)";
  }
  if (call.command === "pnpm" && call.args.join(" ") === "--version") return "pnpm check";
  return commandText(call);
}

/** Corepack exposes pnpm as `pnpm.cmd` on Windows; execute that shim through
 * cmd.exe explicitly because `.cmd` files are not native spawn targets. */
export function resolveInstallSpawn(command, args, platform = process.platform, env = process.env) {
  if (platform === "win32" && command === "pnpm") {
    return {
      args: ["/d", "/c", "pnpm.cmd", ...args],
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe"
    };
  }
  return { args, command };
}

export function defaultInstallRunner({
  command,
  args,
  cwd,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = COMMAND_TIMEOUT_MS
}) {
  return new Promise((resolve, reject) => {
    const resolved = resolveInstallSpawn(command, args, platform, env);
    const child = spawnImpl(resolved.command, resolved.args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

function commandText(call) {
  return `${call.command} ${call.args.join(" ")}`;
}

function requireSourceCheckout(root) {
  for (const marker of ["package.json", "pnpm-workspace.yaml", ".git"]) {
    if (!existsSync(join(root, marker))) {
      throw new Error(`source install requires a Muse git checkout; missing ${marker} under ${root}`);
    }
  }
}

async function requireSuccessful(run, call, label) {
  const result = await run(call);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

export async function runSourceInstall(options = {}) {
  const root = options.root ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const run = options.run ?? defaultInstallRunner;
  const stdout = options.stdout ?? ((line) => process.stdout.write(line));
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const dryRun = options.dryRun ?? false;

  if (!supportsNode(nodeVersion)) {
    throw new Error(`Muse requires Node.js >=22.12; current version is ${nodeVersion}`);
  }
  requireSourceCheckout(root);

  const gitBranch = await requireSuccessful(
    run,
    { args: ["rev-parse", "--abbrev-ref", "HEAD"], command: "git", cwd: root },
    "git branch check"
  );
  if (gitBranch.stdout.trim() !== "main") {
    throw new Error(`source install requires the main branch; current branch is '${gitBranch.stdout.trim() || "unknown"}'`);
  }
  const gitStatus = await requireSuccessful(
    run,
    { args: ["status", "--porcelain"], command: "git", cwd: root },
    "git status check"
  );
  if (gitStatus.stdout.trim()) {
    throw new Error("source install requires a clean checkout; commit or discard local changes first");
  }
  const commands = sourceInstallCommands(root);
  if (dryRun) {
    stdout("Muse source install dry run — no files or global links were changed:\n");
    for (const call of commands) stdout(`  ${commandText(call)}\n`);
    return;
  }

  for (const [index, call] of commands.entries()) {
    stdout(`[${String(index + 1)}/${String(commands.length)}] ${commandText(call)}\n`);
    await requireSuccessful(run, call, sourceInstallLabel(call));
  }
  stdout("\nMuse source install complete.\n");
  stdout("  Start:     muse onboard\n");
  stdout("  Update:    muse update\n");
  stdout("  Uninstall: pnpm --global remove @muse/cli\n");
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runSourceInstall({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    process.stderr.write(`Muse source install failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
