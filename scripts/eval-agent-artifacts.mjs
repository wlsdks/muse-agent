#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureRuntimeArtifacts,
} from "./eval-agent-provenance.mjs";
import {
  bindCapabilityArtifactRoot,
  capabilityRunnerPath,
} from "./eval-agent-artifact-root.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");

/** Recompute the current fixed runtime manifest without returning any paths. */
export function createArtifactDigestReport(dependencies = {}) {
  const repoRoot = dependencies.repoRoot ?? REPO_ROOT;
  const artifactRootBinding = dependencies.artifactRootBinding;
  if (!artifactRootBinding) return { status: "unknown", count: 0 };
  const runnerPath = dependencies.runnerPath ?? capabilityRunnerPath(artifactRootBinding);
  const captureArtifacts = dependencies.captureArtifacts ?? captureRuntimeArtifacts;
  try {
    const snapshot = captureArtifacts({
      artifactRoot: artifactRootBinding.root,
      artifactRootBinding,
      repoRoot,
      runnerPath,
    });
    if (
      snapshot?.status === "ok"
      && typeof snapshot.digest === "string"
      && /^[a-f0-9]{64}$/u.test(snapshot.digest)
      && Number.isSafeInteger(snapshot.count)
      && snapshot.count > 0
    ) {
      return { status: "ok", digest: snapshot.digest, count: snapshot.count };
    }
  } catch {
    // Fail closed below without serializing exception text.
  }
  return { status: "unknown", count: 0 };
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  let artifactRootBinding;
  try {
    const index = args.indexOf("--artifact-root");
    const duplicate = args.filter((arg) => arg === "--artifact-root").length !== 1;
    const requestedRoot = duplicate || index < 0 ? undefined : args[index + 1];
    artifactRootBinding = bindCapabilityArtifactRoot(
      dependencies.repoRoot ?? REPO_ROOT,
      requestedRoot,
    );
  } catch {
    // Fail closed below without exposing path or filesystem details.
  }
  const report = createArtifactDigestReport({ ...dependencies, artifactRootBinding });
  const stdout = dependencies.stdout ?? process.stdout;
  if (args.includes("--json")) {
    stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    const digest = report.status === "ok" ? ` ${report.digest} (${report.count.toString()} files)` : "";
    stdout.write(`runtime-artifacts ${report.status}${digest}\n`);
  }
  if (report.status !== "ok") {
    const setExitCode = dependencies.setExitCode ?? ((value) => { process.exitCode = value; });
    setExitCode(1);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
