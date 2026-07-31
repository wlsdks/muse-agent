import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runFile = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const fixtureRoot = join(packageRoot, "fixtures/portable-v1");
const generator = join(packageRoot, "scripts/generate-attunegraph-portable-fixtures.mjs");
const oracle = join(packageRoot, "scripts/verify-attunegraph-portable-fixtures.mjs");
const temporaryRoots: string[] = [];
let refreshCorpusForTest: (options: {
  readonly targetRoot: string;
  readonly failOperations?: readonly string[];
  readonly failFinalVerification?: boolean;
}) => Promise<void>;

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function run(
  script: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  return runFile(process.execPath, [script, ...args], {
    cwd: packageRoot,
    env
  });
}

async function rejects(script: string, args: readonly string[], env = process.env): Promise<void> {
  await expect(run(script, args, env)).rejects.toThrow();
}

async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const output = new Map<string, Buffer>();
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const relative = join(prefix, name);
      try {
        output.set(relative, await readFile(join(directory, name)));
      } catch {
        await walk(join(directory, name), relative);
      }
    }
  };
  await walk(root);
  return output;
}

async function temporaryCorpus(): Promise<string> {
  const parent = await temporary("attunegraph-refresh-");
  const target = join(parent, "portable-v1");
  await cp(fixtureRoot, target, { recursive: true, errorOnExist: true });
  return target;
}

async function captureRefreshFailure(options: {
  readonly targetRoot: string;
  readonly failOperations?: readonly string[];
  readonly failFinalVerification?: boolean;
}): Promise<Error & {
  readonly state: string;
  readonly recoveryPath?: string;
  readonly secondary: readonly unknown[];
  readonly pendingCleanupPaths: readonly string[];
}> {
  try {
    await refreshCorpusForTest(options);
  } catch (cause) {
    return cause as Error & {
      readonly state: string;
      readonly recoveryPath?: string;
      readonly secondary: readonly unknown[];
      readonly pendingCleanupPaths: readonly string[];
    };
  }
  throw new Error("expected refresh failure");
}

beforeAll(async () => {
  await runFile("pnpm", ["build"], { cwd: packageRoot });
  ({ refreshCorpusForTest } = await import(pathToFileURL(generator).href));
});

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("production AttuneGraph portable fixture integration", () => {
  it("keeps production, clean-room, and checked-in bytes and reports identical", async () => {
    const production = await temporary("attunegraph-production-");
    const cleanRoom = await temporary("attunegraph-clean-room-");
    await run(generator, ["--output-dir", production]);
    await run(oracle, ["--output-dir", cleanRoom]);
    expect(await snapshot(production)).toEqual(await snapshot(cleanRoom));
    expect(await snapshot(production)).toEqual(await snapshot(fixtureRoot));
  });

  it("rejects candidate-local artifact, README, and semantic-input authority mutations", async () => {
    for (const name of [
      "empty.atgx",
      "README.md",
      "empty.input.json"
    ]) {
      const corpus = await temporary("attunegraph-mutated-");
      await run(generator, ["--output-dir", corpus]);
      const path = join(corpus, name);
      const bytes = await readFile(path);
      bytes[0] = bytes[0]! ^ 1;
      await writeFile(path, bytes);
      await rejects(generator, ["--check-dir", corpus]);
      await rejects(oracle, ["--check-dir", corpus]);
    }
  });

  it("fails closed for unsafe modes and unsafe output paths", async () => {
    const before = await snapshot(fixtureRoot);
    await run(generator, ["--check-dir", fixtureRoot]);
    expect(await snapshot(fixtureRoot)).toEqual(before);

    const repositoryChild = join(packageRoot, `.portable-output-${process.pid}`);
    await mkdir(repositoryChild);
    temporaryRoots.push(repositoryChild);
    const nonempty = await temporary("attunegraph-nonempty-");
    await writeFile(join(nonempty, "occupied"), "x");
    const linkParent = await temporary("attunegraph-link-parent-");
    const linkTarget = await temporary("attunegraph-link-target-");
    const link = join(linkParent, "output-link");
    await symlink(linkTarget, link);
    await rejects(generator, ["--output-dir", repositoryRoot]);
    await rejects(generator, ["--output-dir", repositoryChild]);
    await rejects(generator, ["--output-dir", fixtureRoot]);
    await rejects(generator, ["--output-dir", link]);
    await rejects(generator, ["--output-dir", nonempty]);
    await rejects(generator, ["--check-dir", join(tmpdir(), `missing-${process.pid}`)]);
    await rejects(generator, ["--unknown"]);
    await rejects(generator, ["--check", "--write"]);
    await rejects(generator, ["--write", fixtureRoot]);
    await rejects(generator, ["--output-dir", linkTarget, "extra"]);
  });

  it("accounts for every publish and restore rename boundary in temporary roots", async () => {
    for (const failOperations of [
      ["preserve-original"],
      ["publish-stage"],
      ["publish-stage", "cleanup-stage"],
      ["publish-stage", "restore-original"]
    ]) {
      const targetRoot = await temporaryCorpus();
      const before = await snapshot(targetRoot);
      const failure = await captureRefreshFailure({
        targetRoot,
        failOperations
      });
      if (failOperations.includes("restore-original")) {
        expect(failure.state).toBe("recovery-pending-target-absent");
        expect(failure.recoveryPath).toBeDefined();
        expect(await snapshot(failure.recoveryPath!)).toEqual(before);
      } else if (failOperations.includes("cleanup-stage")) {
        expect(failure.state).toBe("restored-cleanup-pending");
        expect(failure.recoveryPath).toBeDefined();
        expect(failure.pendingCleanupPaths).toEqual([failure.recoveryPath]);
        expect(await snapshot(failure.recoveryPath!)).toEqual(before);
      } else {
        expect(await snapshot(targetRoot)).toEqual(before);
      }
      expect(failure.message).toContain("primary=");
    }

    for (const failOperations of [
      ["quarantine-published"],
      ["restore-original"]
    ]) {
      const targetRoot = await temporaryCorpus();
      const before = await snapshot(targetRoot);
      const failure = await captureRefreshFailure({
        targetRoot,
        failFinalVerification: true,
        failOperations
      });
      expect(failure.recoveryPath).toBeDefined();
      expect(await snapshot(failure.recoveryPath!)).toEqual(before);
      expect(failure.secondary.length).toBeGreaterThan(0);
    }
  });

  it("retains a verified target and exact backup on backup cleanup failure", async () => {
    const targetRoot = await temporaryCorpus();
    const before = await snapshot(targetRoot);
    const failure = await captureRefreshFailure({
      targetRoot,
      failOperations: ["cleanup-backup"]
    });
    expect(failure.state).toBe("verified-cleanup-pending");
    expect(await snapshot(targetRoot)).toEqual(before);
    expect(failure.recoveryPath).toBeDefined();
    expect(await snapshot(failure.recoveryPath!)).toEqual(before);
    expect(failure.pendingCleanupPaths).toContain(dirname(failure.recoveryPath!));
  });

  it("reports retained staging when pre-publish cleanup itself fails", async () => {
    const targetRoot = await temporaryCorpus();
    const before = await snapshot(targetRoot);
    const failure = await captureRefreshFailure({
      targetRoot,
      failOperations: ["preserve-original", "cleanup-stage"]
    });
    expect(await snapshot(targetRoot)).toEqual(before);
    expect(failure.recoveryPath).toBeDefined();
    expect(failure.pendingCleanupPaths).toContain(failure.recoveryPath);
    expect(await snapshot(failure.recoveryPath!)).toEqual(before);
  });

  it("does not report an already-published stage during final-verification rollback", async () => {
    const targetRoot = await temporaryCorpus();
    const before = await snapshot(targetRoot);
    const failure = await captureRefreshFailure({
      targetRoot,
      failFinalVerification: true,
      failOperations: ["cleanup-stage"]
    });
    expect(await snapshot(targetRoot)).toEqual(before);
    expect(failure.state).toBe("original-restored");
    expect(failure.recoveryPath).toBeUndefined();
    expect(failure.pendingCleanupPaths).toEqual([]);
    expect(failure.secondary).toEqual([]);
  });

  it("keeps TypeScript build artifacts out of the source scripts directory", async () => {
    const artifacts = (await readdir(dirname(generator))).filter((name) =>
      /^generate-attunegraph-portable-fixtures\.(?:d\.mts(?:\.map)?|mjs\.map)$/u.test(name)
    );
    expect(artifacts).toEqual([]);
  });

  it("pins root, admin, local, backend, testing, extension-kit, and package exports", async () => {
    const [root, admin, local, backend, testing, extensionKit, packageJson] = await Promise.all([
      import("@attunegraph/core"),
      import("@attunegraph/core/admin"),
      import("@attunegraph/core/local"),
      import("@attunegraph/core/backend"),
      import("@attunegraph/core/testing"),
      import("@attunegraph/core/extension-kit"),
      readFile(join(packageRoot, "package.json"), "utf8").then(JSON.parse)
    ]);
    expect(Object.keys(root).sort()).toEqual([
      "ACTIVATION_PREDICATES", "AttuneGraphDataError", "AttuneGraphError",
      "GRAPH_ASSERTION_SOURCE_NAMESPACE", "GRAPH_DERIVATION_KINDS",
      "GRAPH_DIRECTIONS", "GRAPH_EPISTEMIC_CLASSES", "GRAPH_NODE_KINDS",
      "GRAPH_PREDICATES", "InMemoryAttuneGraphDataStore",
      "MAX_ACTIVATION_ESTIMATED_TOKENS", "MAX_GRAPH_APPEND_BATCH_ASSERTIONS",
      "MAX_GRAPH_ASSERTION_SOURCE_REFS", "MAX_GRAPH_QUERY_ASSERTIONS",
      "MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS", "MAX_GRAPH_QUERY_DEPTH",
      "MAX_GRAPH_QUERY_SEEDS", "MAX_GRAPH_QUERY_VISITED_REFS",
      "compileActivationSubgraph", "createAttuneGraphEngine", "openAttuneGraph"
    ]);
    expect(Object.keys(admin).sort()).toEqual([
      "AttuneGraphAdminReadonlyError",
      "openAttuneGraphAdminReadonlyApplication"
    ]);
    expect(Object.keys(local)).toEqual(["openLocalAttuneGraph"]);
    expect(Object.keys(backend)).toEqual(["createAttuneGraphStore"]);
    expect(Object.keys(testing).sort()).toEqual([
      "InMemoryAttuneGraphStoreBackend", "createInMemoryAttuneGraphStore",
      "runAttuneGraphDataStoreConformance", "runAttuneGraphStoreConformance"
    ]);
    expect(Object.keys(extensionKit).sort()).toEqual([
      "CANONICAL_IMMUTABLE_ENVELOPE_LIMITS",
      "CanonicalImmutableEnvelopeError",
      "canonicalAssertion",
      "canonicalizeImmutableEnvelope",
      "evidenceRefBaseKey",
      "evidenceRefKey",
      "findThreadRootedWitnessPath",
      "graphRefKey",
      "instantEpoch",
      "normalizeGraphAssertion",
      "normalizeGraphAssertionBatch",
      "normalizeGraphQueryPlan",
      "settleCandidateInventory"
    ]);
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".", "./admin", "./backend", "./extension-kit", "./local",
      "./readonly-working-graph", "./testing"
    ]);
  });
});
