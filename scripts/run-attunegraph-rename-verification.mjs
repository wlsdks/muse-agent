import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const COMMAND_MATRIX = [
  ["diff-check", ["git", "diff", "--check", "{baseline}...{candidate}"]],
  ["naming-tests", ["node", "--test", "scripts/check-attunegraph-naming.test.mjs"]],
  ["naming-check", ["pnpm", "check:attunegraph-naming"]],
  ["boundary-tests", ["node", "--test", "scripts/check-attunegraph-boundary.test.mjs"]],
  ["core-typecheck", ["pnpm", "--filter", "@attunegraph/core", "typecheck"]],
  ["core-build", ["pnpm", "--filter", "@attunegraph/core", "build"]],
  ["core-test", ["pnpm", "--filter", "@attunegraph/core", "test"]],
  ["core-focused-tests", ["pnpm", "--dir", "packages/attunegraph", "exec", "vitest", "run", "src/attunegraph-engine.test.ts", "src/local.test.ts", "src/attunegraph-local-protocol.test.ts", "src/attunegraph-portable-encoder.test.ts", "src/attunegraph-portable-decoder.test.ts", "src/attunegraph-portable-fixtures.test.ts", "src/attunegraph-portable-indexed-validation-sink.test.ts", "src/attunegraph-admin-staging-lifecycle.test.ts", "src/attunegraph-admin-readonly-protocol-spine.test.ts", "src/attunegraph-admin-readonly-snapshot.test.ts", "src/attunegraph-admin-readonly-inspector.test.ts", "src/attunegraph-admin-readonly-worker.test.ts"]],
  ["portable-generation", ["pnpm", "--filter", "@attunegraph/core", "fixtures:portable"]],
  ["fixture-clean", ["git", "-C", "packages/attunegraph", "diff", "--exit-code", "HEAD", "--", "fixtures/portable-v1", "src/fixtures", "attunegraph-local-runtime-manifest.json"]],
  ["portable-verify", ["pnpm", "--filter", "@attunegraph/core", "verify:portable-fixtures"]],
  ["local-verify", ["pnpm", "--filter", "@attunegraph/core", "verify:local"]],
  ["integration-typecheck", ["pnpm", "--filter", "@muse/attunegraph", "typecheck"]],
  ["integration-build", ["pnpm", "--filter", "@muse/attunegraph", "build"]],
  ["integration-test", ["pnpm", "--filter", "@muse/attunegraph", "test"]],
  ["integration-focused-tests", ["pnpm", "--dir", "packages/muse-attunegraph", "exec", "vitest", "run", "src/trigger-control-lineage-projection.test.ts", "src/continuity-resume-runtime.test.ts", "src/continuity-capsule-presentation.test.ts", "src/shadow-decision-receipt.test.ts", "src/provider-bound-graph-evidence.test.ts", "src/receipt-bound-graph-evidence.test.ts"]],
  ["autoconfigure-typecheck", ["pnpm", "--filter", "@muse/autoconfigure", "typecheck"]],
  ["autoconfigure-build", ["pnpm", "--filter", "@muse/autoconfigure", "build"]],
  ["autoconfigure-focused-tests", ["pnpm", "--dir", "packages/autoconfigure", "exec", "vitest", "run", "test/trigger-lineage-execution-adapter.test.ts", "test/continuity-pack-tools.test.ts"]],
  ["changed-tests", ["pnpm", "test:changed"]],
  ["fast-typecheck", ["pnpm", "typecheck:fast"]],
  ["lint", ["pnpm", "lint"]],
  ["doc-links", ["pnpm", "check:doc-links"]],
  ["doc-claims", ["pnpm", "check:doc-claims"]],
  ["doc-sections", ["pnpm", "check:doc-sections"]],
  ["check", ["pnpm", "check"]]
];

const git = (args, cwd = process.cwd()) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const parseArgs = (argv) => Object.fromEntries(argv.slice(2).reduce((pairs, value, index, values) => value.startsWith("--") ? [...pairs, [value.slice(2), values[index + 1]]] : pairs, []));

export function materializeCommandMatrix({ baseline, candidate }, matrix = COMMAND_MATRIX) {
  return matrix.map(([name, argv]) => [
    name,
    argv.map((value) => value
      .replaceAll("{baseline}", baseline)
      .replaceAll("{candidate}", candidate))
  ]);
}

export function parseTestCounts(output) {
  const pass = output.match(/(?:#|ℹ)\s+pass\s+(\d+)|Tests\s+(\d+)\s+passed/gi) ?? [];
  const fail = output.match(/(?:#|ℹ)\s+fail\s+(\d+)|Tests\s+(\d+)\s+failed/gi) ?? [];
  const number = (matches) => matches.reduce((total, value) => total + Number(value.match(/(\d+)/)?.[1] ?? 0), 0);
  return { passed: number(pass), failed: number(fail) };
}

export function assertCandidate({ baseline, candidate, cwd = process.cwd(), status = () => git(["status", "--porcelain=v1", "--untracked-files=all"], cwd), resolve = (ref) => git(["rev-parse", "--verify", `${ref}^{commit}`], cwd), parent = () => git(["rev-parse", "HEAD^"], cwd) }) {
  const head = resolve("HEAD");
  const resolvedCandidate = resolve(candidate);
  const resolvedBaseline = resolve(baseline);
  if (resolvedCandidate !== head) throw new Error("candidate must resolve to current HEAD");
  if (parent() !== resolvedBaseline) throw new Error("candidate parent must equal baseline");
  if (status() !== "") throw new Error("candidate worktree must be clean");
  return { baseline: resolvedBaseline, candidate: head };
}

export function runMatrix({ cwd = process.cwd(), matrix = COMMAND_MATRIX, invoke = (argv) => spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" }) } = {}) {
  const receipts = [];
  for (let sequence = 0; sequence < matrix.length; sequence += 1) {
    const [name, argv] = matrix[sequence];
    const startedAt = new Date().toISOString();
    const result = invoke(argv);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const receipt = { sequence, name, argv, startedAt, endedAt: new Date().toISOString(), exitCode: result.status ?? 1, testCounts: parseTestCounts(output) };
    receipts.push(receipt);
    if (receipt.exitCode !== 0) throw new Error(`verification command failed: ${name}`);
  }
  return receipts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv);
    if (!args.baseline || !args.candidate || !args.receipts) throw new Error("--baseline, --candidate, and --receipts are required");
    const commits = assertCandidate(args);
    const receipts = runMatrix({ matrix: materializeCommandMatrix(commits) });
    assertCandidate(args);
    writeFileSync(args.receipts, `${JSON.stringify({ version: 1, ...commits, receipts }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
